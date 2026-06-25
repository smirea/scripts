import PostalMime from 'postal-mime';

interface Env {
  ALLOWED_SENDERS: string;
  DB: D1Database;
  EMAIL_BUCKET: R2Bucket;
  READ_TOKEN?: string;
}

interface ForwardedHeaders {
  from?: string;
  to?: string;
  date?: string;
  subject?: string;
}

interface GmailForwardedConversation {
  subject: string | null;
  parts: GmailForwardedPart[];
}

interface GmailForwardedPart extends ForwardedHeaders {
  index: number;
  text: string;
  html: string | null;
}

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;
type ParsedAttachments = NonNullable<ParsedEmail['attachments']>;

interface StoredEmailInput {
  id: string;
  dedupeKey: string;
  receivedAt: string;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  normalizedSubject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  threadKey: string;
  threadBasis: string;
  forwarded: ForwardedHeaders;
  raw: ArrayBuffer | string;
  headers: Record<string, unknown>;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachments;
}

interface EmailRow {
  id: string;
  dedupe_key: string;
  received_at: string;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  normalized_subject: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  thread_key: string;
  thread_basis: string;
  forwarded_from: string | null;
  forwarded_to: string | null;
  forwarded_date: string | null;
  forwarded_subject: string | null;
  raw_key: string;
  headers_key: string;
  text_key: string | null;
  html_key: string | null;
  attachment_count: number;
  raw_size: number;
}

const encoder = new TextEncoder();

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const fromAddr = parsed.from?.address || message.from;

    if (!isAllowedSender(fromAddr, env.ALLOWED_SENDERS)) {
      console.log(`Ignoring email from disallowed sender: ${fromAddr}`);
      return;
    }

    const receivedAt = new Date().toISOString();
    const subject = parsed.subject || message.headers.get('subject') || null;
    const emails = await buildEmailsToStore({
      raw,
      parsed,
      fromAddr,
      toAddr: message.to,
      receivedAt,
      subject,
      headers: message.headers,
    });

    for (const email of emails) {
      await storeEmail(env, email);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: 'unauthorized' }, 401);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/emails') {
      const limit = clampLimit(url.searchParams.get('limit'));
      const threadKey = url.searchParams.get('threadKey');
      const rows = threadKey
        ? await env.DB.prepare(`
            SELECT * FROM emails
            WHERE thread_key = ?
            ORDER BY received_at DESC
            LIMIT ?
          `).bind(threadKey, limit).all<EmailRow>()
        : await env.DB.prepare(`
            SELECT * FROM emails
            ORDER BY received_at DESC
            LIMIT ?
          `).bind(limit).all<EmailRow>();

      return json({ emails: rows.results });
    }

    const emailMatch = url.pathname.match(/^\/emails\/([^/]+)$/);
    if (request.method === 'GET' && emailMatch) {
      const email = await loadEmail(env.DB, emailMatch[1]);
      if (!email) return json({ error: 'not_found' }, 404);

      const attachments = await env.DB.prepare(`
        SELECT id, attachment_index, filename, mime_type, content_id, size, r2_key
        FROM attachments
        WHERE email_id = ?
        ORDER BY attachment_index
      `).bind(email.id).all();

      const include = url.searchParams.get('include') || '';
      const body = include.split(',').map((part) => part.trim()).filter(Boolean);

      return json({
        email,
        attachments: attachments.results,
        text: body.includes('text') && email.text_key ? await getText(env.EMAIL_BUCKET, email.text_key) : undefined,
        html: body.includes('html') && email.html_key ? await getText(env.EMAIL_BUCKET, email.html_key) : undefined,
      });
    }

    const objectMatch = url.pathname.match(/^\/emails\/([^/]+)\/(raw|headers)$/);
    if (request.method === 'GET' && objectMatch) {
      const email = await loadEmail(env.DB, objectMatch[1]);
      if (!email) return json({ error: 'not_found' }, 404);

      const key = objectMatch[2] === 'raw' ? email.raw_key : email.headers_key;
      const object = await env.EMAIL_BUCKET.get(key);
      if (!object) return json({ error: 'object_not_found' }, 404);

      return new Response(object.body, {
        headers: {
          'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
        },
      });
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

async function buildEmailsToStore(input: {
  raw: ArrayBuffer;
  parsed: ParsedEmail;
  fromAddr: string;
  toAddr: string;
  receivedAt: string;
  subject: string | null;
  headers: Headers;
}): Promise<StoredEmailInput[]> {
  const text = input.parsed.text || null;
  const html = input.parsed.html || null;
  const bodyText = text || htmlToText(html || '');
  const gmailConversation = parseGmailForwardedConversation(bodyText, html, input.subject);

  if (gmailConversation?.parts.length) {
    return buildGmailForwardedEmails(input, gmailConversation);
  }

  const normalizedSubject = normalizeSubject(input.subject);
  const forwarded = extractForwardedHeaders(bodyText);
  const thread = await buildThreadKey(input.headers, normalizedSubject, forwarded);
  const dedupeKey = await buildRegularDedupeKey(input);
  const id = await idFromDedupeKey(dedupeKey);

  return [{
    id,
    dedupeKey,
    receivedAt: input.receivedAt,
    fromAddr: input.fromAddr,
    toAddr: input.toAddr,
    subject: input.subject,
    normalizedSubject,
    messageId: input.headers.get('message-id'),
    inReplyTo: input.headers.get('in-reply-to'),
    referencesHeader: input.headers.get('references'),
    threadKey: thread.key,
    threadBasis: thread.basis,
    forwarded,
    raw: input.raw,
    headers: headersToObject(input.headers),
    text,
    html,
    attachments: input.parsed.attachments,
  }];
}

async function buildGmailForwardedEmails(
  input: {
    raw: ArrayBuffer;
    parsed: ParsedEmail;
    fromAddr: string;
    toAddr: string;
    receivedAt: string;
    subject: string | null;
    headers: Headers;
  },
  conversation: GmailForwardedConversation,
): Promise<StoredEmailInput[]> {
  const sourceHeaders = headersToObject(input.headers);
  const normalizedConversationSubject = normalizeSubject(conversation.subject || input.subject);
  const sourceMessageId = input.headers.get('message-id');
  const sourceHash = await sha256Bytes(input.raw);
  const threadSeed = normalizedConversationSubject || sourceMessageId || sourceHash;
  const threadKey = `gmail-forwarded:${await sha256(threadSeed)}`;
  const threadBasis = 'gmail-forwarded-conversation';
  const emails: StoredEmailInput[] = [];

  for (const part of conversation.parts) {
    const subject = part.subject || conversation.subject || input.subject;
    const normalizedSubject = normalizeSubject(subject);
    const dedupeKey = [
      'gmail-forwarded',
      normalizedConversationSubject || '',
      String(part.index),
      normalizeAddressish(part.from),
      normalizeAddressish(part.to),
      normalizeDateish(part.date),
      normalizedSubject || '',
    ].join(':');
    const id = await idFromDedupeKey(dedupeKey);
    const receivedAt = forwardedDateToIso(part.date) || input.receivedAt;
    const messageId = `<gmail-forwarded-${id}@email-save.local>`;
    const fromAddr = extractEmailAddress(part.from) || part.from || input.fromAddr;
    const toAddr = extractEmailAddress(part.to) || part.to || input.toAddr;
    const raw = buildSyntheticRawEmail({
      from: part.from || fromAddr,
      to: part.to || toAddr,
      date: part.date || receivedAt,
      subject,
      messageId,
      text: part.text,
      sourceMessageId,
      forwardedIndex: part.index,
    });

    emails.push({
      id,
      dedupeKey,
      receivedAt,
      fromAddr,
      toAddr,
      subject,
      normalizedSubject,
      messageId,
      inReplyTo: input.headers.get('in-reply-to'),
      referencesHeader: input.headers.get('references'),
      threadKey,
      threadBasis,
      forwarded: {
        from: part.from,
        to: part.to,
        date: part.date,
        subject: subject || undefined,
      },
      raw,
      headers: {
        source: {
          from: input.fromAddr,
          to: input.toAddr,
          subject: input.subject,
          message_id: sourceMessageId,
          references: input.headers.get('references'),
          in_reply_to: input.headers.get('in-reply-to'),
        },
        source_headers: sourceHeaders,
        gmail_forwarded_conversation: {
          subject: conversation.subject,
          part_index: part.index,
          part_count: conversation.parts.length,
        },
        forwarded_headers: {
          from: part.from || null,
          to: part.to || null,
          date: part.date || null,
          subject: subject || null,
        },
      },
      text: part.text,
      html: part.html,
      attachments: [],
    });
  }

  return emails;
}

async function storeEmail(env: Env, email: StoredEmailInput): Promise<void> {
  const baseKey = `emails/${email.id}`;
  const rawKey = `${baseKey}/raw.eml`;
  const headersKey = `${baseKey}/headers.json`;
  const textKey = email.text ? `${baseKey}/body.txt` : null;
  const htmlKey = email.html ? `${baseKey}/body.html` : null;
  const rawSize = byteLength(email.raw);

  await env.EMAIL_BUCKET.put(rawKey, email.raw, {
    httpMetadata: { contentType: 'message/rfc822' },
  });

  await env.EMAIL_BUCKET.put(headersKey, JSON.stringify(email.headers, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  if (textKey && email.text) {
    await env.EMAIL_BUCKET.put(textKey, email.text, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
  }

  if (htmlKey && email.html) {
    await env.EMAIL_BUCKET.put(htmlKey, email.html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  }

  const attachmentRows = await storeAttachments(env.EMAIL_BUCKET, baseKey, email.id, email.attachments);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments WHERE email_id = ?').bind(email.id),
    env.DB.prepare(`
      INSERT INTO emails (
        id, dedupe_key, received_at, from_addr, to_addr, subject, normalized_subject,
        message_id, in_reply_to, references_header, thread_key, thread_basis,
        forwarded_from, forwarded_to, forwarded_date, forwarded_subject,
        raw_key, headers_key, text_key, html_key, attachment_count, raw_size
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        received_at = excluded.received_at,
        from_addr = excluded.from_addr,
        to_addr = excluded.to_addr,
        subject = excluded.subject,
        normalized_subject = excluded.normalized_subject,
        message_id = excluded.message_id,
        in_reply_to = excluded.in_reply_to,
        references_header = excluded.references_header,
        thread_key = excluded.thread_key,
        thread_basis = excluded.thread_basis,
        forwarded_from = excluded.forwarded_from,
        forwarded_to = excluded.forwarded_to,
        forwarded_date = excluded.forwarded_date,
        forwarded_subject = excluded.forwarded_subject,
        raw_key = excluded.raw_key,
        headers_key = excluded.headers_key,
        text_key = excluded.text_key,
        html_key = excluded.html_key,
        attachment_count = excluded.attachment_count,
        raw_size = excluded.raw_size
    `).bind(
      email.id,
      email.dedupeKey,
      email.receivedAt,
      email.fromAddr,
      email.toAddr,
      email.subject,
      email.normalizedSubject,
      email.messageId,
      email.inReplyTo,
      email.referencesHeader,
      email.threadKey,
      email.threadBasis,
      email.forwarded.from || null,
      email.forwarded.to || null,
      email.forwarded.date || null,
      email.forwarded.subject || null,
      rawKey,
      headersKey,
      textKey,
      htmlKey,
      attachmentRows.length,
      rawSize,
    ),
    ...attachmentRows.map((attachment) =>
      env.DB.prepare(`
        INSERT INTO attachments (
          id, email_id, attachment_index, filename, mime_type, content_id, size, r2_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        attachment.id,
        attachment.emailId,
        attachment.index,
        attachment.filename,
        attachment.mimeType,
        attachment.contentId,
        attachment.size,
        attachment.key,
      ),
    ),
  ]);
}

function isAllowedSender(address: string, allowed: string): boolean {
  const normalized = address.trim().toLowerCase();
  return allowed.split(',').map((entry) => entry.trim().toLowerCase()).includes(normalized);
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return Boolean(env.READ_TOKEN && token && token === env.READ_TOKEN);
}

function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;

  let value = subject.trim();
  let previous = '';

  while (value !== previous) {
    previous = value;
    value = value.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
  }

  return value.toLowerCase().replace(/\s+/g, ' ') || null;
}

export function parseGmailForwardedConversation(
  text: string,
  html: string | null = null,
  fallbackSubject: string | null = null,
): GmailForwardedConversation | null {
  const lines = normalizeLineEndings(text).split('\n');
  const markerIndex = lines.findIndex((line) => line.trim().toLowerCase() === 'forwarded conversation');
  if (markerIndex === -1) return null;

  const separatorIndex = lines.findIndex((line, index) => index > markerIndex && /^-{5,}$/.test(line.trim()));
  if (separatorIndex === -1) return null;

  const subject = firstHeader(lines.slice(markerIndex + 1, separatorIndex).join('\n'), 'subject') || fallbackSubject;
  const contentStart = nextNonBlankLine(lines, separatorIndex + 1);
  const starts: number[] = [];

  for (let index = contentStart; index < lines.length; index++) {
    if (!/^From:\s*/i.test(lines[index] || '')) continue;
    if (starts.length === 0 || previousNonBlankLine(lines, index - 1) === '----------') {
      starts.push(index);
    }
  }

  if (!starts.length) return null;

  const htmlParts = splitGmailForwardedHtml(html, starts.length);
  const parts = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const blockLines = trimBlockLines(lines.slice(start, end));
    const part = parseGmailForwardedPart(blockLines);

    return {
      ...part,
      index,
      subject: part.subject || subject || undefined,
      html: htmlParts[index] || null,
    };
  }).filter((part) => part.from || part.date || part.text);

  return parts.length ? { subject: subject || null, parts } : null;
}

function parseGmailForwardedPart(lines: string[]): Omit<GmailForwardedPart, 'index' | 'html'> {
  const headers: Record<string, string> = {};
  let currentHeader: string | null = null;
  let bodyStart = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || '';

    if (!line.trim()) {
      bodyStart = index + 1;
      break;
    }

    const match = line.match(/^([A-Za-z][A-Za-z-]*):\s*(.*)$/);
    if (match) {
      currentHeader = match[1].toLowerCase();
      headers[currentHeader] = match[2].trim();
      bodyStart = index + 1;
      continue;
    }

    if (!currentHeader) {
      bodyStart = index;
      break;
    }

    headers[currentHeader] = `${headers[currentHeader]} ${line.trim()}`.trim();
    bodyStart = index + 1;
  }

  return {
    from: cleanForwardedHeader(headers.from),
    to: cleanForwardedHeader(headers.to),
    date: cleanForwardedHeader(headers.date),
    subject: cleanForwardedHeader(headers.subject),
    text: trimText(lines.slice(bodyStart).join('\n')),
  };
}

function splitGmailForwardedHtml(html: string | null, expectedParts: number): string[] {
  if (!html) return [];

  const starts = [...html.matchAll(/<div\b[^>]*class="[^"]*\bgmail_attr\b[^"]*"[^>]*>/gi)]
    .map((match) => match.index)
    .filter((index): index is number => typeof index === 'number');

  if (starts.length < expectedParts) return [];

  return starts.slice(0, expectedParts).map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length).trim(),
  );
}

function cleanForwardedHeader(value: string | undefined): string | undefined {
  return value
    ?.replace(/\s+/g, ' ')
    .replace(/<\s+/g, '<')
    .replace(/\s+>/g, '>')
    .trim() || undefined;
}

function nextNonBlankLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && !lines[index].trim()) index++;
  return index;
}

function previousNonBlankLine(lines: string[], start: number): string | null {
  for (let index = start; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (line) return line;
  }

  return null;
}

function trimBlockLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start].trim()) start++;
  while (end > start && (!lines[end - 1].trim() || /^-{5,}$/.test(lines[end - 1].trim()))) end--;

  return lines.slice(start, end);
}

function trimText(text: string): string {
  return text.replace(/^\s+|\s+$/g, '');
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

async function buildThreadKey(
  headers: Headers,
  normalizedSubject: string | null,
  forwarded: ForwardedHeaders,
): Promise<{ key: string; basis: string }> {
  const references = headers.get('references');
  const inReplyTo = headers.get('in-reply-to');
  const messageThread = references || inReplyTo;

  if (messageThread) {
    return { key: `headers:${await sha256(messageThread)}`, basis: 'headers' };
  }

  const forwardedSubject = normalizeSubject(forwarded.subject);
  if (forwardedSubject) {
    return { key: `forwarded-subject:${await sha256(forwardedSubject)}`, basis: 'forwarded-subject' };
  }

  if (normalizedSubject) {
    return { key: `subject:${await sha256(normalizedSubject)}`, basis: 'subject' };
  }

  return { key: `message:${crypto.randomUUID()}`, basis: 'message' };
}

async function buildRegularDedupeKey(input: {
  raw: ArrayBuffer;
  subject: string | null;
  fromAddr: string;
  toAddr: string;
  headers: Headers;
}): Promise<string> {
  const messageId = input.headers.get('message-id');
  if (messageId) return `message-id:${messageId.trim().toLowerCase()}`;

  const rawHash = await sha256Bytes(input.raw);
  return [
    'raw',
    input.fromAddr.trim().toLowerCase(),
    input.toAddr.trim().toLowerCase(),
    normalizeSubject(input.subject) || '',
    rawHash,
  ].join(':');
}

async function idFromDedupeKey(dedupeKey: string): Promise<string> {
  return sha256(dedupeKey);
}

function forwardedDateToIso(value: string | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\bat\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const timestamp = Date.parse(normalized);

  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function extractEmailAddress(value: string | undefined): string | null {
  if (!value) return null;
  const bracketed = value.match(/<([^<>@\s]+@[^<>\s]+)>/);
  if (bracketed) return bracketed[1].trim().toLowerCase();

  const plain = value.match(/\b[^@\s<>]+@[^@\s<>]+\b/);
  return plain ? plain[0].trim().toLowerCase() : null;
}

function normalizeAddressish(value: string | undefined): string {
  return (extractEmailAddress(value) || value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeDateish(value: string | undefined): string {
  return forwardedDateToIso(value) || (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildSyntheticRawEmail(input: {
  from: string;
  to: string;
  date: string;
  subject: string | null;
  messageId: string;
  text: string;
  sourceMessageId: string | null;
  forwardedIndex: number;
}): string {
  const headers = [
    ['From', input.from],
    ['To', input.to],
    ['Date', input.date],
    ['Subject', input.subject || '(no subject)'],
    ['Message-ID', input.messageId],
    ['X-Email-Save-Source-Message-ID', input.sourceMessageId || ''],
    ['X-Email-Save-Forwarded-Index', String(input.forwardedIndex)],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=utf-8'],
  ];

  return `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${input.text}`;
}

function byteLength(value: ArrayBuffer | string): number {
  return typeof value === 'string' ? encoder.encode(value).byteLength : value.byteLength;
}

function extractForwardedHeaders(body: string): ForwardedHeaders {
  const markerIndex = body.search(/-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:/i);
  if (markerIndex === -1) return {};

  const headerText = body.slice(markerIndex).split(/\n\s*\n/, 1)[0] || '';

  return {
    from: firstHeader(headerText, 'from'),
    to: firstHeader(headerText, 'to'),
    date: firstHeader(headerText, 'date'),
    subject: firstHeader(headerText, 'subject'),
  };
}

function firstHeader(text: string, name: string): string | undefined {
  const pattern = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  return text.match(pattern)?.[1]?.trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function storeAttachments(
  bucket: R2Bucket,
  baseKey: string,
  emailId: string,
  attachments: NonNullable<Awaited<ReturnType<typeof PostalMime.parse>>['attachments']>,
) {
  const rows = [];

  for (const [index, attachment] of attachments.entries()) {
    const filename = attachment.filename || `attachment-${index}`;
    const key = `${baseKey}/attachments/${index}-${safeFilename(filename)}`;
    const content = attachment.content instanceof ArrayBuffer
      ? attachment.content
      : encoder.encode(String(attachment.content));
    const mimeType = attachment.mimeType || 'application/octet-stream';

    await bucket.put(key, content, {
      httpMetadata: { contentType: mimeType },
    });

    rows.push({
      id: crypto.randomUUID(),
      emailId,
      index,
      filename,
      mimeType,
      contentId: attachment.contentId || null,
      size: content.byteLength,
      key,
    });
  }

  return rows;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'attachment';
}

async function loadEmail(db: D1Database, id: string): Promise<EmailRow | null> {
  return db.prepare('SELECT * FROM emails WHERE id = ?').bind(id).first<EmailRow>();
}

async function getText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object ? object.text() : null;
}

function clampLimit(value: string | null): number {
  const parsed = Number(value || 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
