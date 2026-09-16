#!/usr/bin/env bun
import { createCli } from './utils/yargs';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import env from './env';
import { printRich, type RichPerson } from './utils/222Rich';
import { createScript } from './utils/createScript';

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
  await createCli('222')
    .option('format', { choices: ['md', 'json', 'rich'] as const, default: 'md', description: 'Output format; rich shows styled events and inline attendee photos in iTerm2' })
    .option('api-key', { type: 'string', requiresArg: true, description: 'Override the saved TWOTWOTWO_API_KEY for this run' })
    .option('refresh-session', { type: 'boolean', default: false, description: 'Fetch and save a fresh token from signed-in Chrome via BrowserGate' })
    .check(args => {
      if (args['api-key'] !== undefined && args['refresh-session']) throw new Error('Use either --api-key or --refresh-session, not both.');
      return true;
    })
    .command('invites', 'List current and upcoming invites across cities', parser => parser
      .option('all', { type: 'boolean', default: false, description: 'Include invites marked NOT_INTERESTED' }), async args => {
      const api = new Api(args['api-key'], args['refresh-session']);
      const [current, upcoming] = await Promise.all([
        api.get('/get_members_current_events', z.object({ current_events: z.array(eventSchema) })),
        api.get('/get_members_upcoming_events', z.object({ upcoming_events: z.array(eventSchema) })),
      ]);
      const invites = sortEvents([...new Map(
        [...upcoming.upcoming_events, ...current.current_events].map(event => [event.id, event]),
      ).values()].filter(event => args.all || event.rsvp?.status !== 'NOT_INTERESTED'));
      if (args.format === 'json') {
        console.log(JSON.stringify({ invites }, null, 2));
      } else {
        const markdown = [
          `# 222 invites (${invites.length})`,
          ...invites.map(event => inviteMarkdown(event, args.format !== 'rich')),
          ...(invites.length ? [] : ['No invites.']),
        ].join('\n\n');
        if (args.format === 'rich') {
          await printRich(markdown, invites.map(richPeople));
        } else console.log(markdown);
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
        const markdown = [
          `# 222 available events (${events.length})`,
          'Location: your current 222 account location.',
          ...Object.entries(metadata).filter(([key]) => key !== 'requestable_dates').map(([key, value]) => markdownField(key, value)),
          ...events.map(event => `## ${escapeMarkdown(event.title)}\n\n${Object.entries(event)
            .filter(([key]) => key !== 'title')
            .map(([key, value]) => markdownField(key, displayValue(event, key, value))).filter(Boolean).join('\n')}`),
          ...(events.length ? [] : ['No available events.']),
        ].filter(Boolean).join('\n\n');
        if (args.format === 'rich') await printRich(markdown);
        else console.log(markdown);
      }
    })
    .demandCommand(1, 'Choose invites or events.')
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

function inviteMarkdown(event: Event, includePeople = true): string {
  const rsvp = record(event.rsvp);
  const locations = [...records(event.venues), ...records(event.current_instruction_elements).map(item => record(item.venue))]
    .filter(venue => venue.name || venue.address);
  const venues = [...new Map(locations.map(venue => [venue.id ?? `${venue.name}:${venue.address}`, venue])).values()].map(venueMarkdown);
  const stages = records(record(event.timeline).stages).map(stage => {
    const approximate = record(stage.location_coordinate_obfuscated);
    const coordinate = record(approximate.coordinate);
    return [
      `- **${escapeMarkdown(String(stage.title ?? 'Stage'))}** — ${escapeMarkdown(String(dateValue(stage.start_date_time, event) ?? 'Time to be announced'))}`,
      fieldsMarkdown({
        description: stage.subtitle,
        location_revealed: dateValue(stage.location_reveal_date_time, event),
        approximate_area: typeof coordinate.lat === 'number' && typeof coordinate.lon === 'number'
          ? `${coordinate.lat}, ${coordinate.lon}; obfuscated radius ${approximate.obfuscation_radius_miles} miles — not an exact venue location`
          : undefined,
      }, '  '),
    ].filter(Boolean).join('\n');
  });
  const instructions = records(event.current_instruction_elements).map(instruction => {
    const venue = record(instruction.venue);
    return [
      `- **${escapeMarkdown(String(instruction.title ?? 'Arrival instructions'))}**`,
      fieldsMarkdown({
        when: dateValue(instruction.date_time, event),
        venue: venue.name,
        address: venue.address,
        instructions: instruction.details,
        reservation: instruction.table,
        ticket: instruction.external_ticket_url,
        ticket_image: instruction.ticket_image_url,
        qr_code: instruction.qr_code_image_url,
      }, '  '),
    ].filter(Boolean).join('\n');
  });
  const reveals = records(record(rsvp.additional_timeline_metadata).additional_points)
    .map(point => `${String(point.label)}: ${String(dateValue(point.date_time, event))}`);
  const people = otherAttendees(event).map(personMarkdown);
  const guests = records(rsvp.plus_ones).map(personMarkdown);
  return [
    `## ${statusEmoji(event)} ${escapeMarkdown(event.title)} (${shortDate(event)})`,
    venues.join('\n'),
    event.blurb ? escapeMarkdown(event.blurb) : '',
    section('Locations & itinerary', [...stages, ...instructions,
      reveals.length ? markdownField('reveal schedule', reveals) : '',
      !venues.length ? 'Exact venues have not been returned by the API yet.' : '',
    ].filter(Boolean).join('\n\n')),
    people.length || guests.length ? [
      '### People',
      includePeople ? people.join('\n') : '',
      guests.length ? `Guests:\n\n${guests.join('\n')}` : '',
    ].filter(Boolean).join('\n\n') : '',
    section('Details', fieldsMarkdown({ description: event.description, notes: nonempty(event.details), attributes: nonempty(event.attributes) })),
  ].filter(Boolean).join('\n\n');
}

function statusEmoji(event: Event): string {
  const status = event.rsvp?.status;
  if (event.is_canceled || ['NOT_INTERESTED', 'DECLINED', 'REJECTED', 'CANCELED', 'CANCELLED', 'BAILED'].includes(status ?? '')) return '❌';
  return ['CONFIRMED', 'SELECTED', 'ATTENDING'].includes(status ?? '') ? '✅' : '❓';
}

function shortDate(event: Event): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: event.time_zone,
  }).formatToParts(new Date(event.start_date_time));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const day = Number(value('day'));
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] ?? 'th');
  return `${value('weekday')}, ${value('month')} ${day}${suffix}`;
}

function otherAttendees(event: Event): Record<string, unknown>[] {
  const rsvp = record(event.rsvp);
  const currentUserId = rsvp.member_id ?? record(rsvp.member).id;
  return records(event.group_attendees).filter(person => !currentUserId || record(person.member).id !== currentUserId);
}

function richPeople(event: Event): RichPerson[] {
  return otherAttendees(event).map(person => {
    const member = record(person.member);
    const outcome = record(member.outcome);
    return {
      name: String(member.simplified_name ?? member.name ?? 'Unnamed attendee'),
      imageUrl: typeof member.profile_photo_url === 'string' ? member.profile_photo_url : undefined,
      personality: typeof outcome.personality_type === 'string' ? outcome.personality_type : undefined,
      status: humanize(person.checked_in_status),
    };
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function nonempty(value: unknown): unknown {
  return Array.isArray(value) && !value.length ? undefined : value;
}

function humanize(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toLowerCase().replaceAll('_', ' ') : undefined;
}

function dateValue(value: unknown, event: Event): string | undefined {
  return typeof value === 'string' ? localDate(value, event.time_zone) : undefined;
}

function fieldsMarkdown(fields: Record<string, unknown>, indent = ''): string {
  return Object.entries(fields).map(([key, value]) => markdownField(key, value, indent)).filter(Boolean).join('\n');
}

function section(title: string, body: string): string {
  return body ? `### ${title}\n\n${body}` : '';
}

function venueMarkdown(venue: Record<string, unknown>): string {
  const coordinate = record(venue.coordinate);
  const query = venue.address ?? (typeof coordinate.lat === 'number' && typeof coordinate.lon === 'number'
    ? `${coordinate.lat},${coordinate.lon}` : undefined);
  const label = `${escapeMarkdown(String(venue.name ?? 'Venue'))}${venue.address ? ` (${escapeMarkdown(String(venue.address))})` : ''}`;
  return `- ${label}${query ? ` [map](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(query))})` : ''}`;
}

function personMarkdown(person: Record<string, unknown>): string {
  const member = person.member ? record(person.member) : person;
  const outcome = record(member.outcome);
  return [
    `- **${escapeMarkdown(String(member.simplified_name ?? member.name ?? 'Unnamed attendee'))}**`,
    fieldsMarkdown({
      personality: outcome.personality_type,
      check_in_status: humanize(person.checked_in_status),
      message: person.member_reported_checked_in_message,
    }, '  '),
    typeof member.profile_photo_url === 'string' && /^https?:\/\//.test(member.profile_photo_url)
      ? `  - [Profile photo](<${member.profile_photo_url.replaceAll('>', '%3E')}>)` : '',
  ].filter(Boolean).join('\n');
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
