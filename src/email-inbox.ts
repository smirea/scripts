#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { convert } from 'html-to-text';

import env from './env';

const inboxes = ['email-save', 'spam'] as const;
type Inbox = typeof inboxes[number];

interface InboxStats {
  total_emails: number;
  last_email_at: string | null;
}

interface EmailRow {
  id: string;
  received_at: string;
  from_addr: string;
  subject: string | null;
  forwarded_from: string | null;
  forwarded_subject: string | null;
  thread_key: string;
  attachment_count: number;
}

interface EmailListResponse {
  emails: EmailRow[];
}

interface EmailResponse {
  email: EmailRow;
  attachments: Array<{
    filename: string | null;
    mime_type: string;
    size: number;
  }>;
  text?: string | null;
  html?: string | null;
}

if (import.meta.main) {
  void run();
}

async function run(): Promise<void> {
  const cli = createScript('email-inbox');
  await cli
    .usage('$0 [command] [options]')
    .option('inbox', {
      alias: 'i',
      type: 'string',
      choices: inboxes,
      default: env.EMAIL_INBOX || 'email-save',
      coerce: (value: string): Inbox => {
        const inbox = inboxes.find(inbox => inbox === value)
          ?? (/^\d+$/.test(value) ? inboxes[Number(value)] : undefined);
        if (!inbox) throw new Error('Inbox must be email-save (0) or spam (1).');
        return inbox;
      },
      describe: 'Inbox name or index: email-save (0), spam (1); also set with EMAIL_INBOX.',
    })
    .command(
      'list',
      'List recent saved emails.',
      command => command
        .option('limit', {
          type: 'number',
          default: 20,
          describe: 'Maximum number of emails to return, from 1 to 100.',
        })
        .option('thread-key', {
          type: 'string',
          describe: 'Only show emails in this thread.',
        })
        .option('format', {
          type: 'string',
          choices: ['text', 'json'] as const,
          default: 'text' as const,
          describe: 'Output format (JSON includes the complete API response).',
        }),
      async argv => {
        const params = new URLSearchParams({ limit: String(argv.limit) });
        if (argv.threadKey) params.set('threadKey', argv.threadKey);
        const result = await requestJson<EmailListResponse>(argv.inbox, `/emails?${params}`);

        if (argv.format === 'json') {
          printJson(result);
          return;
        }

        console.table(result.emails.map(email => ({
          received: formatDate(email.received_at),
          from: email.forwarded_from ?? email.from_addr,
          subject: email.forwarded_subject ?? email.subject ?? '',
          attachments: email.attachment_count,
          id: email.id,
        })));
      },
    )
    .command(
      'read [id]',
      'Read a saved email, or the latest email when no id is given.',
      command => command
        .positional('id', {
          type: 'string',
          describe: 'Email id or zero-based inbox index, newest first (defaults to 0).',
        })
        .option('format', {
          type: 'string',
          choices: ['text', 'html', 'json'] as const,
          default: 'text' as const,
          describe: 'Output format (JSON includes metadata, attachments, and both bodies).',
        })
        .option('fallback', {
          type: 'boolean',
          default: true,
          describe: 'Use the other body when the selected body is missing or blank (disable with --no-fallback).',
        }),
      async argv => {
        let id = argv.id;
        const isIndex = id !== undefined && /^-?\d+(?:\.\d+)?$/.test(id) && !/^[a-f0-9]{64}$/i.test(id);
        if (id === undefined || isIndex) {
          const index = Number(id ?? 0);
          if (!Number.isSafeInteger(index) || index < 0) {
            throw new Error('Email index must be a non-negative safe integer.');
          }
          const result = await requestJson<EmailListResponse>(argv.inbox, `/emails?limit=1&offset=${index}`);
          id = result.emails[0]?.id;
          if (id === undefined) {
            throw new Error(index === 0
              ? `No emails in the ${argv.inbox} inbox.`
              : `No email at index ${index} in the ${argv.inbox} inbox.`);
          }
        }
        const result = await requestJson<EmailResponse>(
          argv.inbox,
          `/emails/${encodeURIComponent(id)}?include=text,html`,
        );

        if (argv.format === 'json') {
          printJson(result);
          return;
        }

        printEmail(result, argv.format, argv.fallback);
      },
    )
    .command(
      'raw <id>',
      'Print or save the original .eml file.',
      command => command
        .positional('id', {
          type: 'string',
          demandOption: true,
          describe: 'Email id from the list command.',
        })
        .option('output', {
          alias: 'o',
          type: 'string',
          describe: 'Write the .eml file to this path instead of stdout.',
        }),
      async argv => {
        const response = await apiRequest(argv.inbox, `/emails/${encodeURIComponent(argv.id)}/raw`);
        const raw = Buffer.from(await response.arrayBuffer());
        if (argv.output) {
          const outputPath = path.resolve(argv.output);
          writeFileSync(outputPath, raw);
          process.stdout.write(`${outputPath}\n`);
          return;
        }
        process.stdout.write(raw);
      },
    )
    .command(
      '$0',
      false,
      command => command,
      async () => {
        const rows = await Promise.all(inboxes.map(async inbox => {
          const stats = await requestJson<InboxStats>(inbox, '/stats');
          const lastEmail = stats.last_email_at ? new Date(stats.last_email_at) : null;
          return {
            Inbox: `${inbox}@stf.lol`,
            'Total emails': stats.total_emails,
            'Last email date': lastEmail?.toLocaleDateString() ?? '-',
            'Last email time': lastEmail?.toLocaleTimeString() ?? '-',
          };
        }));
        console.table(rows);
        process.stdout.write('\n');
        cli.showHelp(help => process.stdout.write(`${help}\n`));
      },
    )
    .recommendCommands()
    .parseAsync();
}

async function requestJson<T>(inbox: Inbox, pathname: string): Promise<T> {
  return apiRequest(inbox, pathname).then(response => response.json() as Promise<T>);
}

async function apiRequest(inbox: Inbox, pathname: string): Promise<Response> {
  const baseUrl = env.EMAIL_INBOX_URL.replace(/\/$/, '');
  const url = new URL(`${baseUrl}${pathname}`);
  url.searchParams.set('inbox', inbox);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${env.EMAIL_INBOX_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Email inbox request failed (${response.status}): ${body || response.statusText}`);
  }

  return response;
}

function printEmail(result: EmailResponse, format: 'text' | 'html', fallback: boolean): void {
  const email = result.email;
  const lines = [
    `Subject: ${email.forwarded_subject ?? email.subject ?? ''}`,
    `From: ${email.forwarded_from ?? email.from_addr}`,
    `Received: ${formatDate(email.received_at)}`,
    `Thread: ${email.thread_key}`,
  ];
  if (result.attachments.length > 0) {
    lines.push(`Attachments: ${result.attachments.map(attachment => attachment.filename ?? attachment.mime_type).join(', ')}`);
  }
  let body = (format === 'html' ? result.html : result.text) ?? '';
  if (fallback && !body.trim()) {
    body = format === 'html'
      ? result.text ?? ''
      : convert(result.html ?? '', { wordwrap: process.stdout.columns || 100 });
  }
  lines.push('', body);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
