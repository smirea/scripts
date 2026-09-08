#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './src/env';
import { createScript } from './src/utils/createScript';
import { failWithFullHelp } from './src/utils/yargs';

const ORIGIN = 'https://www.airbnb.com';
const QUERIES = {
  WishlistIndexPageQuery: 'b8b421d802c399b55fb6ac1111014807a454184ad38f198365beb7836c018c18',
  WishlistDetailPageDataQuery: '5f6b671df39f7e5c9ffc249e202d303d71ae50ed46992749740e465c9890801a',
  ReservationTripIdQuery: '10cf039494ea9e4bd4c17730769d87330507a0c7961dffc5a4503eceb8762acc',
  TripDetailsQuery: '6f13e0c1fc266717018b6c9495e9037dc2631afef81ec06bcdfacc71bde64d48',
  TripListQuery: 'df014f46481f7983138aecade25270a79e4f6794a850052deeb4bc93d30fa051',
} as const;
type RecordValue = Record<string, any>;

if (import.meta.main) {
  void createScript(async () => {
    await yargs(hideBin(process.argv))
      .scriptName('airbnb')
      .version(false)
      .option('refresh-session', { type: 'boolean', default: false, describe: 'Refresh saved credentials from Chrome via Browser Gate before reading data.' })
      .command('reservations [code]', 'Read current/upcoming stays, or a reservation by confirmation code, as Markdown.',
        command => command.positional('code', { type: 'string', describe: 'Airbnb confirmation code, including past reservations.' }),
        async args => {
          if (args.code && !/^[A-Z0-9]{8,12}$/i.test(args.code)) throw new Error('Use an Airbnb confirmation code.');
          console.log(await reservations(await createClient(args.refreshSession), args.code?.toUpperCase()));
        })
      .command('wishlists [id]', 'Read all wishlists, or a wishlist with saved listings, notes, and votes, as Markdown.',
        command => command.positional('id', { type: 'string', describe: 'Numeric wishlist ID from the list output or Airbnb URL.' }),
        async args => {
          if (args.id && !/^\d+$/.test(args.id)) throw new Error('Use a numeric wishlist ID.');
          console.log(await wishlists(await createClient(args.refreshSession), args.id));
        })
      .demandCommand(1, 'Choose reservations or wishlists.')
      .strict()
      .wrap(process.stdout.columns || 100)
      .fail(failWithFullHelp)
      .help()
      .parseAsync();
  });
}

async function createClient(refresh: boolean): Promise<AirbnbClient> {
  let cookie = env.AIRBNB_SESSION_COOKIE;
  let apiKey = env.AIRBNB_API_KEY;
  if (refresh) {
    const invoke = path.join(homedir(), 'code/chrome-browsergate/scripts/invoke');
    if (!existsSync(invoke)) throw new Error(`Browser Gate is missing at ${invoke}.`);
    const result = spawnSync(invoke, ['get-session', `${ORIGIN}/trips`, '--json'], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Could not read the Airbnb session. Open Chrome with Browser Gate enabled and sign in to airbnb.com.');
    const session = JSON.parse(result.stdout);
    if (session.strategy !== 'airbnb' || session.tokenType !== 'cookie' || !session.token) throw new Error('Rebuild and reload Browser Gate with its Airbnb session strategy.');
    cookie = session.token;
    const response = await fetch(`${ORIGIN}/trips`, { headers: { cookie: cookie! }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Open Airbnb in Chrome and complete sign-in or verification before refreshing.');
    const html = await response.text();
    const instances = scriptJson(html, 'data-injector-instances');
    if (!instances.root?.find(([name, value]: [string, RecordValue]) => name === 'UserDataToken' && value?.id)) throw new Error('Sign in to Airbnb in Chrome, then retry.');
    apiKey = scriptJson(html, 'data-initializer-bootstrap')['layout-init']?.api_config?.key;
    if (!apiKey) throw new Error('Airbnb page data changed: missing API configuration.');
    const client = new AirbnbClient(cookie!, apiKey);
    await client.query('TripListQuery', {});
    const file = path.join(import.meta.dir, '.env.local');
    let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const [key, value] of Object.entries({ AIRBNB_SESSION_COOKIE: cookie!, AIRBNB_API_KEY: apiKey })) {
      const line = `${key}=${JSON.stringify(value)}`;
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      content = pattern.test(content) ? content.replace(pattern, () => line) : `${content.trimEnd()}\n${line}\n`;
    }
    writeFileSync(file, content, { mode: 0o600 });
    console.error('Refreshed Airbnb credentials in .env.local. Normal commands use the API directly.');
    return client;
  }
  if (!cookie || !apiKey) throw new Error('Run airbnb reservations --refresh-session once to save credentials from your signed-in Chrome session.');
  return new AirbnbClient(cookie, apiKey);
}

class AirbnbClient {
  constructor(private readonly cookie: string, private readonly apiKey: string) {}

  private async request(url: URL, headers: Record<string, string> = {}): Promise<Response> {
    if (url.origin !== ORIGIN) throw new Error('Airbnb requests must stay on www.airbnb.com.');
    const response = await fetch(url, {
      headers: { cookie: this.cookie, ...headers },
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new Error('Airbnb requires sign-in or browser verification. Open airbnb.com in Chrome, complete it, then rerun with --refresh-session.');
    }
    if (!response.ok) throw new Error(`Airbnb returned HTTP ${response.status}. Try again later.`);
    return response;
  }

  async query(name: keyof typeof QUERIES, variables: RecordValue): Promise<RecordValue> {
    const hash = QUERIES[name];
    const url = new URL(`/api/v3/${name}/${hash}`, ORIGIN);
    url.search = new URLSearchParams({
      operationName: name, locale: 'en', currency: 'USD', variables: JSON.stringify(variables),
      extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
    }).toString();
    const response = await this.request(url, { 'x-airbnb-api-key': this.apiKey, 'x-airbnb-supports-airlock-v2': 'true' });
    let result: RecordValue;
    try { result = await response.json(); } catch { throw new Error('Airbnb returned non-JSON data. Check the site in Chrome and retry.'); }
    if (result.errors?.length || !result.data) {
      throw new Error(`Airbnb could not run ${name}. Check access in Chrome; its private query definition may have changed.`);
    }
    return result.data;
  }
}

async function reservations(client: AirbnbClient, code?: string): Promise<string> {
  let trips: RecordValue[];
  if (code) {
    const matches = (await client.query('ReservationTripIdQuery', { confirmationCode: code, isStay: true, isActivity: false })).stayReservations;
    const trip = matches?.[0]?.trip;
    if (!trip?.id) throw new Error('Reservation not found or unavailable to this account.');
    trips = [trip];
  } else {
    let connection = (await client.query('TripListQuery', {})).viewer?.trips;
    trips = nodes(connection);
    const cursors = new Set<string>();
    while (connection.pageInfo?.hasNextPage) {
      const after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error('Airbnb trip pagination stopped advancing.');
      cursors.add(after);
      const data = await client.query('TripListQuery', { after });
      connection = data.viewer?.trips;
      trips.push(...nodes(connection));
    }
  }
  const sections: string[] = [];
  for (const trip of trips) {
    const id = rawId(trip.id);
    const details = (await client.query('TripDetailsQuery', { tripId: trip.id })).node;
    if (!details) throw new Error(`Trip ${id} is unavailable.`);
    for (const item of nodes(details.scheduledItems)) {
      const stay = item.details?.stayReservation;
      if (!stay || (code && stay.confirmationCode !== code)) continue;
      const listing = stay.supplyListing;
      const rooms = listing?.roomsAndSpaces;
      const rating = listing?.demandListing?.listingRatingStats?.overallRatingStats;
      sections.push([
        `## ${md(details.displayName)} — ${md(stay.confirmationCode)}`,
        '',
        field('Status', stay.guestFacingStatus ?? details.status),
        field('Check-in', localTime(item.start?.dateTime)),
        field('Check-out', localTime(item.end?.dateTime)),
        field('Address', item.guestFacingLocation?.oneLineAddress),
        field('Host', listing?.primaryHostUser?.displayFirstName),
        field('Guests', guests(stay.guestCountDetails)),
        field('Travelers', nodes(details.travelers).map(t => t.user?.displayFirstName).filter(Boolean).join(', ')),
        rooms ? field('Rooms', [countLabel(rooms.numberOfBedrooms, 'bedroom'), countLabel(rooms.numberOfBeds, 'bed'), countLabel(rooms.numberOfBathrooms, 'bathroom')].filter(Boolean).join(', ')) : '',
        rating ? field('Rating', `${rating.ratingAverage}/5 (${rating.ratingCount} reviews)`) : '',
        listing?.id ? `- [Listing](${ORIGIN}/rooms/${rawId(listing.id)})` : '',
        `- [Trip details](${ORIGIN}/trips/v1/${id})`,
      ].filter(line => line !== '').join('\n').replace(/\n-/, '\n\n-'));
    }
  }
  if (code && sections.length === 0) throw new Error('No stay details were returned for that confirmation code.');
  return [`# Airbnb reservations${code ? '' : ' — current and upcoming'}`, ...sections.length ? sections : ['No stay reservations found.']].join('\n\n');
}

async function wishlists(client: AirbnbClient, id?: string): Promise<string> {
  if (id) {
    const data = await client.query('WishlistDetailPageDataQuery', { wishlistID: btoa(`Wishlist:${id}`) });
    if (!data.node) throw new Error('Wishlist not found or unavailable to this account.');
    return wishlistDetails(data.node, id);
  }
  let lists = (await client.query('WishlistIndexPageQuery', { limit: 12, offset: 0, treatmentFlags: ['wishlist_should_load_service'] })).presentation?.wishlistIndexPage?.wishlists;
  if (!Array.isArray(lists)) throw new Error('Airbnb wishlist response changed.');
  const all = new Map<string, RecordValue>();
  let offset = 0;
  while (true) {
    const previousSize = all.size;
    for (const list of lists) all.set(list.id, list);
    if (lists.length < 12) break;
    if (all.size === previousSize) throw new Error('Airbnb wishlist pagination stopped advancing.');
    offset += lists.length;
    const data = await client.query('WishlistIndexPageQuery', { limit: 12, offset, treatmentFlags: ['wishlist_should_load_service'] });
    lists = data.presentation?.wishlistIndexPage?.wishlists;
    if (!Array.isArray(lists)) throw new Error('Airbnb wishlist response changed.');
  }
  return ['# Airbnb wishlists', ...Array.from(all.values(), list => {
    const products = Object.entries(list.productIds ?? {}).filter(([key, value]) => key !== '__typename' && Array.isArray(value));
    return [
      `## [${md(list.name)}](${ORIGIN}/wishlists/${rawId(list.id)})`, '',
      field('ID', rawId(list.id)),
      field('Owner', list.wishlistUser?.contextualUser?.displayFirstName),
      field('Privacy', list.isPrivate ? 'Private' : 'Public'),
      field('Collaborators', (list.collaboratorUsers ?? []).map((u: RecordValue) => u.contextualUser?.displayFirstName).filter(Boolean).join(', ')),
      field('Dates', dateRange(list.dateRangeDetails)),
      field('Guests', guests(list.guestDetails)),
      field('Saved items', products.filter(([, value]) => (value as unknown[]).length > 0).map(([key, value]) => countLabel((value as unknown[]).length, ({ stayIds: 'stay', experienceIds: 'experience', placeIds: 'place', airbnbCanonicalPlaceIds: 'place' } as Record<string, string>)[key] ?? key.replace(/Ids$/, ''))).join(', ') || '0'),
    ].filter(Boolean).join('\n').replace(/\n-/, '\n\n-');
  }), ...all.size ? [] : ['No wishlists found.']].join('\n\n');
}

function wishlistDetails(list: RecordValue, id: string): string {
  const items = nodes(list.wishlistItems);
  const sections = [
    `# ${md(list.name)}`, `[Open wishlist](${ORIGIN}/wishlists/${id})`,
    [field('Owner', list.wishlistUser?.contextualUser?.displayFirstName), field('Dates', dateRange(list.dateRangeDetails)), field('Guests', guests(list.guestDetails)), field('Saved items', items.length)].filter(Boolean).join('\n'),
  ];
  for (const item of items) {
    const card = item.dumbledoreListing;
    const listing = card?.listing;
    const price = card?.pricingQuote?.structuredStayDisplayPrice;
    const activity = item.listing;
    const activityRating = activity?.listingRatingStats?.overallRatingStats;
    const title = activity?.descriptions?.name?.localizedValue?.localizedStringWithTranslationPreference ?? listing?.subtitle ?? listing?.title ?? item.title ?? `${item.__typename?.replace(/WishlistItem$/, '') ?? 'Saved item'} ${item.entityId}`;
    const url = item.__typename === 'StayWishlistItem' ? `${ORIGIN}/rooms/${encodeURIComponent(item.entityId)}` : item.__typename === 'ExperienceWishlistItem' ? `${ORIGIN}/experiences/${encodeURIComponent(item.entityId)}` : undefined;
    const summary = [
      `## ${url ? `[${md(title)}](${url})` : md(title)}`, '',
      field('Location', listing?.title),
      field('Description', activity?.descriptions?.byline?.localizedValue?.localizedStringWithTranslationPreference),
      field('Rating', listing?.avgRatingA11yLabel ?? (activityRating ? `${activityRating.ratingAverage}/5 (${activityRating.ratingCount} reviews)` : undefined)),
      field('Price', price?.primaryLine?.accessibilityLabel ?? item.displayPrice?.primaryLine?.accessibilityLabel),
      field('Availability', typeof item.isAvailable === 'boolean' ? (item.isAvailable ? 'Available for saved search' : 'Unavailable for saved search') : undefined),
      field('Details', listing?.structuredContent?.primaryLine?.map((line: RecordValue) => line.body).filter(Boolean).join(', ')),
      field('Votes', item.votes?.map((vote: RecordValue) => `${vote.user?.contextualUser?.displayFirstName ?? 'Guest'}: ${vote.vote}`).join(', ')),
    ].filter(Boolean).join('\n').replace(/\n-/, '\n\n-');
    const notes = (item.notes ?? []).map((note: RecordValue) => `**${md(note.user?.contextualUser?.displayFirstName ?? 'Note')}**\n\n${String(note.noteContent ?? '').split('\n').map(line => `> ${md(line)}`).join('\n')}`);
    sections.push([summary, ...notes].join('\n\n'));
  }
  if (!items.length) sections.push('No saved items.');
  return sections.join('\n\n');
}

function scriptJson(html: string, id: string): RecordValue {
  const text = html.match(new RegExp(`<script\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/script>`))?.[1];
  if (!text) throw new Error('Airbnb page data is unavailable. Open Airbnb in Chrome and check for sign-in or verification.');
  try { return JSON.parse(text); } catch { throw new Error(`Airbnb returned invalid ${id} data.`); }
}

function nodes(connection: RecordValue | undefined): RecordValue[] {
  if (!Array.isArray(connection?.edges)) throw new Error('Airbnb response changed: missing items.');
  return connection.edges.map((edge: RecordValue) => edge.node).filter(Boolean);
}

function rawId(id: string): string {
  const decoded = Buffer.from(id, 'base64').toString('utf8').split(':').at(-1);
  if (!decoded || !/^\d+$/.test(decoded)) throw new Error('Airbnb returned an invalid ID.');
  return decoded;
}

function md(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>|#]/g, '\\$&');
}

function field(label: string, value: unknown): string {
  return value === undefined || value === null || value === '' ? '' : `- **${label}:** ${md(value)}`;
}

function localTime(value?: RecordValue): string | undefined {
  if (!value?.dateTime) return undefined;
  return `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: value.listingTimeZone }).format(new Date(value.dateTime))} (${value.listingTimeZone})`;
}

function dateRange(value?: RecordValue): string | undefined {
  return value?.checkIn ? `${value.checkIn} → ${value.checkOut ?? 'unspecified'}` : undefined;
}

function guests(value?: RecordValue): string | undefined {
  if (!value) return undefined;
  return Object.entries({ adults: value.numberOfAdults, children: value.numberOfChildren, infants: value.numberOfInfants, pets: value.numberOfPets })
    .filter(([, count]) => typeof count === 'number' && count > 0).map(([label, count]) => countLabel(count, ({ adults: 'adult', children: 'child', infants: 'infant', pets: 'pet' } as Record<string, string>)[label])).join(', ');
}

function countLabel(count: unknown, label: string): string {
  if (typeof count !== 'number') return '';
  return `${count} ${count === 1 ? label : label === 'child' ? 'children' : `${label}s`}`;
}
