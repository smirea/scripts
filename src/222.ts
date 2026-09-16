#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

import env from './env';
import { createScript } from './utils/createScript';
import { failWithFullHelp } from './utils/yargs';

const API_URL = 'https://ios.api.222.place';
const RSVP_URL = 'https://rsvp.222.place/';
const eventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start_date_time: z.string(),
  time_zone: z.string(),
  city: z.string().optional(),
  neighborhood: z.string().optional(),
  blurb: z.string().nullish(),
  payment_deadline_date_time: z.string().nullish(),
  details: z.array(z.string()).optional(),
  rsvp: z.object({ id: z.string(), status: z.string() }).passthrough().optional(),
}).passthrough();
type Event = z.infer<typeof eventSchema>;

createScript(async () => {
  await yargs(hideBin(process.argv))
    .scriptName('222')
    .option('format', { choices: ['md', 'json'] as const, default: 'md', description: 'Output format' })
    .option('api-key', { type: 'string', requiresArg: true, description: 'Override the saved TWOTWOTWO_API_KEY for this run' })
    .option('refresh-session', { type: 'boolean', default: false, description: 'Fetch and save a fresh token from signed-in Chrome via BrowserGate' })
    .check(args => {
      if (args['api-key'] !== undefined && args['refresh-session']) throw new Error('Use either --api-key or --refresh-session, not both.');
      return true;
    })
    .command('invites', 'List all current and upcoming invites across cities', parser => parser, async args => {
      const api = new Api(args['api-key'], args['refresh-session']);
      const [current, upcoming] = await Promise.all([
        api.get('/get_members_current_events', z.object({ current_events: z.array(eventSchema) })),
        api.get('/get_members_upcoming_events', z.object({ upcoming_events: z.array(eventSchema) })),
      ]);
      const invites = sortEvents([...new Map(
        [...upcoming.upcoming_events, ...current.current_events].map(event => [event.id, event]),
      ).values()]);
      if (args.format === 'json') {
        console.log(JSON.stringify({ invites }, null, 2));
      } else {
        console.log([
          `# 222 invites (${invites.length})`,
          ...invites.map(inviteMarkdown),
          ...(invites.length ? [] : ['No invites.']),
        ].join('\n\n'));
      }
    })
    .command('events', 'List available events for your current 222 account location, with all API details', parser => parser, async args => {
      const api = new Api(args['api-key'], args['refresh-session']);
      const response = await api.get('/get_request_new_event_metadata', z.object({
        request_new_event_metadata: z.object({
          requestable_events: z.array(eventSchema),
        }).passthrough(),
      }));
      const { requestable_events, ...metadata } = response.request_new_event_metadata;
      const events = sortEvents(requestable_events);
      if (args.format === 'json') {
        console.log(JSON.stringify({ ...metadata, events }, null, 2));
      } else {
        console.log([
          `# 222 available events (${events.length})`,
          'Location: your current 222 account location.',
          ...Object.entries(metadata).filter(([key]) => key !== 'requestable_dates').map(([key, value]) => markdownField(key, value)),
          ...events.map(event => `## ${escapeMarkdown(event.title)}\n\n${Object.entries(event)
            .filter(([key]) => key !== 'title')
            .map(([key, value]) => markdownField(key, displayValue(event, key, value))).filter(Boolean).join('\n')}`),
          ...(events.length ? [] : ['No available events.']),
        ].filter(Boolean).join('\n\n'));
      }
    })
    .demandCommand(1, 'Choose invites or events.')
    .strict()
    .version(false)
    .wrap(process.stdout.columns || 100)
    .help()
    .fail(failWithFullHelp)
    .parseAsync();
});

class Api {
  private authorization?: string;
  private refreshing?: Promise<string>;

  constructor(private apiKey?: string, refreshSession = false) {
    if (apiKey !== undefined && !apiKey.trim()) throw new Error('--api-key cannot be empty.');
    const savedKey = apiKey ?? env.TWOTWOTWO_API_KEY;
    if (!refreshSession && savedKey?.trim()) this.authorization = tokenHeader(savedKey);
  }

  private refresh(): Promise<string> {
    this.refreshing ??= (async () => {
      const authorization = browserAuthorization();
      const response = await fetch(`${API_URL}/get_authed_member`, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Could not validate the BrowserGate token (HTTP ${response.status}). Sign in at ${RSVP_URL} in Chrome and retry.`);
      }
      const parsed = z.object({ authed_member: z.object({ id: z.string() }) }).safeParse(await response.json());
      if (!parsed.success) throw new Error('222 returned an unexpected authentication response; credentials were not saved.');
      saveApiKey(authorization.replace(/^Token\s+/i, ''));
      this.authorization = authorization;
      return authorization;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async get<T>(endpoint: string, schema: z.ZodType<T>): Promise<T> {
    this.authorization ??= await this.refresh();
    for (let attempt = 0; attempt < 2; attempt++) {
      const authorization: string = this.authorization;
      const response = await fetch(`${API_URL}${endpoint}`, {
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        if (attempt === 0 && !this.apiKey) {
          if (this.authorization === authorization) await this.refresh();
          continue;
        }
        throw new Error('222 authentication failed. Sign in at https://rsvp.222.place/ in Chrome or supply a valid --api-key.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`222 ${endpoint} failed: HTTP ${response.status} ${response.statusText}`);
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new Error(`222 returned an unexpected response for ${endpoint}.`);
      return parsed.data;
    }
    throw new Error('222 authentication failed.');
  }
}

function saveApiKey(token: string): void {
  const file = path.resolve(import.meta.dir, '../.env.local');
  const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `TWOTWOTWO_API_KEY=${JSON.stringify(token)}`;
  const pattern = /^TWOTWOTWO_API_KEY=.*$/gm;
  const updated = pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}\n${line}\n`;
  writeFileSync(file, updated, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.error('Saved 222 credentials in .env.local.');
}

function tokenHeader(token: string): string {
  return `Token ${token.trim().replace(/^Token\s+/i, '')}`;
}

function browserAuthorization(): string {
  const invoke = path.resolve(import.meta.dir, '../../chrome-browsergate/scripts/invoke');
  const result = spawnSync(process.execPath, [invoke, 'get-session', RSVP_URL, '--json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not retrieve the 222 session. Open https://rsvp.222.place/ in Chrome, sign in, and make sure BrowserGate is connected; or supply --api-key.');
  }
  let session;
  try {
    session = z.object({ token: z.string().min(1), tokenType: z.string(), source: z.string() }).parse(JSON.parse(result.stdout));
  } catch {
    throw new Error('BrowserGate did not return a valid 222 session.');
  }
  if (session.tokenType === 'cookie' || session.tokenType === 'bearer') {
    throw new Error('BrowserGate returned a different credential type than the 222 Token API requires. Supply the 222 auth token with --api-key.');
  }
  return tokenHeader(session.token);
}

function sortEvents(events: Event[]): Event[] {
  return events.sort((a, b) => a.start_date_time.localeCompare(b.start_date_time) || a.id.localeCompare(b.id));
}

function inviteMarkdown(event: Event): string {
  const fields: Record<string, unknown> = {
    when: localDate(event.start_date_time, event.time_zone),
    where: [event.city, event.neighborhood].filter(Boolean).join(' — '),
    status: event.rsvp?.status,
    rsvp: event.rsvp ? `${RSVP_URL}?id=${encodeURIComponent(event.rsvp.id)}` : undefined,
    payment_deadline: event.payment_deadline_date_time ? localDate(event.payment_deadline_date_time, event.time_zone) : undefined,
    description: event.blurb,
    details: event.details,
    venues: event.venues,
    event_id: event.id,
  };
  return `## ${escapeMarkdown(event.title)}\n\n${Object.entries(fields)
    .map(([key, value]) => markdownField(key, value)).filter(Boolean).join('\n')}`;
}

function localDate(value: string, timeZone: string): string {
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full', timeStyle: 'short', timeZone,
  }).format(new Date(value))} (${timeZone})`;
}

function displayValue(event: Event, key: string, value: unknown): unknown {
  return key.endsWith('_date_time') && typeof value === 'string' ? localDate(value, event.time_zone) : value;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>#|]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function markdownField(key: string, value: unknown, indent = ''): string {
  if (value === undefined || value === null) return '';
  const label = escapeMarkdown(key.replaceAll('_', ' '));
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}- **${label}:** none`;
    return `${indent}- **${label}:**\n${value.map((item, index) => typeof item === 'object' && item !== null
      ? markdownField(String(index + 1), item, `${indent}  `)
      : `${indent}  - ${escapeMarkdown(String(item))}`).join('\n')}`;
  }
  if (typeof value === 'object') {
    const fields = Object.entries(value).map(([key, child]) => markdownField(key, child, `${indent}  `)).filter(Boolean);
    return fields.length ? `${indent}- **${label}:**\n${fields.join('\n')}` : '';
  }
  return `${indent}- **${label}:** ${escapeMarkdown(String(value))}`;
}
