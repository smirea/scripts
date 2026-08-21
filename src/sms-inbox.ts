#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';

interface MessageRow {
  id: string;
  received_at: string;
  sender: string;
  text: string;
  thread_key: string;
}

interface MessageListResponse {
  messages: MessageRow[];
}

interface MessageResponse {
  message: MessageRow;
}

if (import.meta.main) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function run(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('sms-inbox')
    .version(false)
    .usage('$0 <command> [options]')
    .command(
      'list',
      'List recent saved texts.',
      command => command
        .option('limit', {
          type: 'number',
          default: 20,
          describe: 'Maximum number of messages to return, from 1 to 100.',
        })
        .option('sender', {
          type: 'string',
          describe: 'Only show messages from this number.',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print the complete API response as JSON.',
        }),
      async argv => {
        const params = new URLSearchParams({ limit: String(argv.limit) });
        if (argv.sender) params.set('sender', argv.sender);
        const result = await requestJson<MessageListResponse>(`/messages?${params}`);

        if (argv.json) {
          printJson(result);
          return;
        }

        console.table(result.messages.map(message => ({
          received: formatDate(message.received_at),
          sender: message.sender,
          text: message.text,
          id: message.id,
        })));
      },
    )
    .command(
      'read <id>',
      'Read a saved text.',
      command => command
        .positional('id', {
          type: 'string',
          demandOption: true,
          describe: 'Message id from the list command.',
        })
        .option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print the complete API response as JSON.',
        }),
      async argv => {
        const result = await requestJson<MessageResponse>(
          `/messages/${encodeURIComponent(argv.id)}`,
        );

        if (argv.json) {
          printJson(result);
          return;
        }

        const message = result.message;
        process.stdout.write(
          [
            `From: ${message.sender}`,
            `Received: ${formatDate(message.received_at)}`,
            '',
            message.text,
            '',
          ].join('\n'),
        );
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
  const baseUrl = env.SMS_INBOX_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      authorization: `Bearer ${env.SMS_INBOX_TOKEN}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SMS inbox request failed (${response.status}): ${body || response.statusText}`);
  }

  return response;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
