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

interface EmailRow {
  id: string;
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

    const id = crypto.randomUUID();
    const receivedAt = new Date().toISOString();
    const datePrefix = receivedAt.slice(0, 10);
    const baseKey = `emails/${datePrefix}/${id}`;
    const subject = parsed.subject || message.headers.get('subject') || null;
    const normalizedSubject = normalizeSubject(subject);
    const forwarded = extractForwardedHeaders(parsed.text || htmlToText(parsed.html || ''));
    const thread = await buildThreadKey(message.headers, normalizedSubject, forwarded);
    const rawKey = `${baseKey}/raw.eml`;
    const headersKey = `${baseKey}/headers.json`;
    const text = parsed.text || null;
    const html = parsed.html || null;
    const textKey = text ? `${baseKey}/body.txt` : null;
    const htmlKey = html ? `${baseKey}/body.html` : null;

    await env.EMAIL_BUCKET.put(rawKey, raw, {
      httpMetadata: { contentType: 'message/rfc822' },
    });

    await env.EMAIL_BUCKET.put(headersKey, JSON.stringify(headersToObject(message.headers), null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    if (textKey) {
      await env.EMAIL_BUCKET.put(textKey, text, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      });
    }

    if (htmlKey) {
      await env.EMAIL_BUCKET.put(htmlKey, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
    }

    const attachmentRows = await storeAttachments(env.EMAIL_BUCKET, baseKey, id, parsed.attachments);

    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO emails (
          id, received_at, from_addr, to_addr, subject, normalized_subject,
          message_id, in_reply_to, references_header, thread_key, thread_basis,
          forwarded_from, forwarded_to, forwarded_date, forwarded_subject,
          raw_key, headers_key, text_key, html_key, attachment_count, raw_size
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        receivedAt,
        fromAddr,
        message.to,
        subject,
        normalizedSubject,
        message.headers.get('message-id'),
        message.headers.get('in-reply-to'),
        message.headers.get('references'),
        thread.key,
        thread.basis,
        forwarded.from || null,
        forwarded.to || null,
        forwarded.date || null,
        forwarded.subject || null,
        rawKey,
        headersKey,
        textKey,
        htmlKey,
        attachmentRows.length,
        raw.byteLength,
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
