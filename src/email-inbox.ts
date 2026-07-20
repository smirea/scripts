#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';

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
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function run(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('email-inbox')
    .version(false)
    .usage('$0 <command> [options]')
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
        const result = await requestJson<EmailListResponse>(`/emails?${params}`);

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
      'read <id>',
      'Read a saved email.',
      command => command
        .positional('id', {
          type: 'string',
          demandOption: true,
          describe: 'Email id from the list command.',
        })
        .option('html', {
          type: 'boolean',
          default: false,
          describe: 'Print the HTML body instead of plain text.',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print metadata, attachments, and both bodies as JSON.',
        }),
      async argv => {
        const result = await requestJson<EmailResponse>(
          `/emails/${encodeURIComponent(argv.id)}?include=text,html`,
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
        const response = await apiRequest(`/emails/${encodeURIComponent(argv.id)}/raw`);
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
    .strict()
    .demandCommand(1, 'Choose a command.')
    .recommendCommands()
    .showHelpOnFail(false)
    .wrap(process.stdout.columns || 100)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .help()
    .parseAsync();
}

async function requestJson<T>(pathname: string): Promise<T> {
  return apiRequest(pathname).then(response => response.json() as Promise<T>);
}

async function apiRequest(pathname: string): Promise<Response> {
  const baseUrl = env.EMAIL_INBOX_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${pathname}`, {
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
  lines.push('', (html ? result.html : result.text) ?? '');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
