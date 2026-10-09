#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { convert } from 'html-to-text';

import env from './env';

type Inbox = 'email-save' | 'spam';

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
      choices: ['email-save', 'spam'] as const,
      default: (env.EMAIL_INBOX || 'email-save') as Inbox,
      describe: 'Inbox to query (also set with EMAIL_INBOX).',
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
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print the complete API response as JSON.',
        }),
      async argv => {
        const params = new URLSearchParams({ limit: String(argv.limit) });
        if (argv.threadKey) params.set('threadKey', argv.threadKey);
        const result = await requestJson<EmailListResponse>(argv.inbox, `/emails?${params}`);

        if (argv.json) {
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
          describe: 'Email id from the list command (defaults to the latest email).',
        })
        .option('html', {
          type: 'boolean',
          default: false,
          describe: 'Print the original HTML body instead of readable text.',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print metadata, attachments, and both bodies as JSON.',
        }),
      async argv => {
        let id = argv.id;
        if (id === undefined) {
          const result = await requestJson<EmailListResponse>(argv.inbox, '/emails?limit=1');
          id = result.emails[0]?.id;
          if (id === undefined) throw new Error(`No emails in the ${argv.inbox} inbox.`);
        }
        const result = await requestJson<EmailResponse>(
          argv.inbox,
          `/emails/${encodeURIComponent(id)}?include=text,html`,
        );

        if (argv.json) {
          printJson(result);
          return;
        }

        printEmail(result, argv.html);
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
        const inboxes: Inbox[] = ['email-save', 'spam'];
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

function printEmail(result: EmailResponse, html: boolean): void {
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
  const text = result.text ?? '';
  const body = html
    ? result.html ?? text
    : text.trim() ? text : convert(result.html ?? '', { wordwrap: process.stdout.columns || 100 });
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
