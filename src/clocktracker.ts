#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { format, isValid, parseISO, subDays } from 'date-fns';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { failWithFullHelp } from './utils/yargs';

const API_BASE_URL = 'https://clocktracker.app';
const BROWSER_GATE_HEALTH_URL = 'http://127.0.0.1:17373/health';
const TRACKER_USERNAME = 'cygnets';
const IMPORT_COMMENT = 'imported from clocktracker.app';
const OUTPUT_FORMATS = ['bgstats', 'table'] as const;
const NEW_BG_STATS_PLAYER_NAME_BY_CLOCKTRACKER_ID: Readonly<Record<string, string>> = {
  'clocktracker:name:grant': 'Grant (austin, botc)',
};
const BG_STATS_PLAYER_UUID_BY_CLOCKTRACKER_ID: Readonly<Record<string, string>> = {
  'clocktracker:name:amanda': 'C353A37E-86AB-4A2E-BF8F-61E43411AAAE',
  'clocktracker:name:anna': 'E5EE821E-D347-4104-A779-2F0D8E081285',
  'clocktracker:name:ben-c': 'A83787E1-395F-449F-9C08-7386ED715627',
  'clocktracker:name:brittany': 'D472C086-0778-48FB-A476-68FA011C72EC',
  'clocktracker:name:dak': '60EAF59A-E459-49D0-9E56-6AA559F1BBE6',
  'clocktracker:name:david-m': '6DA0F3E7-F0DC-436E-8159-FDB4B1DC37A3',
  'clocktracker:name:faith': '3BD1CFEA-8A53-4DD4-A1CC-2E6D52E68D77',
  'clocktracker:name:gabby': '946E0CA5-49A5-4B35-BD72-05725A5B84CC',
  'clocktracker:name:garret': '9B273A3A-BC8E-480D-85F9-7C585B45CABE',
  'clocktracker:name:jay': 'B821BA7E-2847-4D95-BA2F-7A10FD79A887',
  'clocktracker:name:johnmark': 'D2F38D5B-6AFC-45C9-9396-A3915FE43E72',
  'clocktracker:name:michael': 'D3887D3F-8CD2-424E-83CB-1AE045A74337',
  'clocktracker:name:neil': 'B9270D75-F3C4-43DD-9F6C-6B5EAE5D7E02',
  'clocktracker:name:nick-f': '1233082F-1C16-4692-BA95-3C4E950701D4',
  'clocktracker:name:philip': '13E59DBD-9ED4-4039-B215-80A8F28722CA',
  'clocktracker:name:ryan-a': '4BE329E9-C69E-44AE-B12F-D724E7BA3ED6',
  'clocktracker:name:sam-j': '7EE4B359-741F-43D8-8FC7-715D95BBDE67',
  'clocktracker:name:sarah-rose': '54D713BB-75D3-4A48-AE28-D78C46621FB0',
  'clocktracker:name:tony-b': '6BE04C48-90F4-4425-A940-7BEFE53D14C1',
  'clocktracker:name:wallace': 'D39F5057-56A8-45AC-B852-1A8AC025B322',
  'clocktracker:name:wayne': 'F6CB3865-D2ED-417B-96EA-512EDF16F2BB',
  'clocktracker:name:z.-bill': '41DEC3C1-EE9B-4E3E-9F1A-E374D34CE052',
  'clocktracker:username:cygnets': '3F772AF2-C583-42FC-A9E5-140C8D47DC47',
  'clocktracker:8bde7e96-5a58-45fe-b0f6-4922fef647b2': 'F3A51F73-7745-4252-A031-B57C5E236B68',
  'clocktracker:93c739ff-3e6e-44f4-bce1-d91fa8196f75': '053BA30C-EC82-4B8D-A72C-D929242B9316',
  'clocktracker:f92cc15b-61e3-400c-8990-2a4c36307067': '6B21A7BC-F5A3-41D2-A137-13E600FF9F94',
};
const BG_STATS_PLAY_UUID_BY_CLOCKTRACKER_ID: Readonly<Record<string, string>> = {
  '6be0e7c2-424d-4e89-a22f-425642f8c9a9': 'A7CE1AA7-9C18-4768-A70C-F586D72BD6D2',
  'f17178e8-5a8d-40bf-8cb8-5a9b65ea859d': '3F321DBB-6015-441D-91E3-4CB690C8F455',
  '7ad4b28b-6557-4c02-9626-a3f2d9f38883': '1C36BAF8-7BE4-4BDF-B38A-0F2DCA4F993C',
  'c53fd20e-a489-4e9c-8a99-11bf412a43b3': '51D03995-4105-4D4D-A8BD-154E9B880208',
  '6c6fc0a8-143e-42c9-b258-6e88207234a4': '590299F6-06C8-49AE-926F-C43F95D0FE9D',
};

type Alignment = 'GOOD' | 'EVIL' | 'NEUTRAL';
type WinStatus = 'GOOD_WINS' | 'EVIL_WINS' | 'NOT_RECORDED';
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface BrowserGateSession {
  token: string;
  tokenType: 'bearer' | 'cookie' | 'value';
  source: 'authorization-header' | 'local-storage' | 'session-storage' | 'cookie';
}

interface ClockTrackerProfile {
  user_id: string;
  username: string;
  display_name: string;
}

interface ClockTrackerCharacter {
  name: string;
  alignment: Alignment;
  role?: {
    type?: string;
  } | null;
}

interface ClockTrackerToken {
  order: number;
  player_id: string | null;
  player_name: string;
  alignment: Alignment;
  role?: {
    name: string;
    type?: string;
  } | null;
  player?: {
    username: string;
    display_name: string;
  } | null;
}

interface ClockTrackerGame {
  id: string;
  user_id: string;
  date: string;
  script: string;
  location_type: 'ONLINE' | 'IN_PERSON';
  location: string;
  community_name: string;
  player_count: number | null;
  traveler_count: number | null;
  win_v2: WinStatus;
  notes: string;
  storyteller: string | null;
  co_storytellers: string[];
  is_storyteller: boolean;
  player_characters: ClockTrackerCharacter[];
  grimoire: Array<{
    tokens: ClockTrackerToken[];
  }>;
}

interface BgStatsPlayer {
  uuid?: string;
  name: string;
  sourcePlayerId: string;
  winner: boolean;
  role?: string;
  team?: string;
  teamRole?: string;
}

interface BgStatsStoredPlayer {
  uuid: string | null;
  name: string | null;
}

interface BgStatsPlay {
  uuid?: string;
  sourceName: string;
  sourcePlayId: string;
  playDate: string;
  comments?: string;
  board?: string;
  location?: string;
  game: {
    name: string;
    sourceGameId: string;
    noPoints: boolean;
    usesTeams: boolean;
  };
  players: BgStatsPlayer[];
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function runCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('clocktracker')
    .version(false)
    .usage('$0 [options]')
    .option('since', {
      type: 'string',
      default: format(subDays(new Date(), 7), 'yyyy-MM-dd'),
      describe: 'Include games on or after this date (YYYY-MM-DD).',
    })
    .option('format', {
      type: 'string',
      choices: OUTPUT_FORMATS,
      default: 'bgstats',
      describe: 'Output BG Stats-compatible JSON or a human-readable table.',
    })
    .option('write', {
      type: 'boolean',
      default: false,
      describe: 'Make these ClockTracker games authoritative in BG Stats.',
    })
    .option('sync-timeout', {
      type: 'number',
      default: 60,
      describe: 'Seconds to wait for each BG Stats Cloud Sync when using --write.',
    })
    .option('database', {
      type: 'string',
      describe: 'Override the BG Stats database path when using --write.',
    })
    .example('$0 --since 2026-07-01', 'Read games since July 1 as BG Stats JSON.')
    .example('$0 --format table', 'Show games from the past week in a table.')
    .example('$0 --write', 'Update existing source plays and record new ones in BG Stats.')
    .strict()
    .wrap(process.stdout.columns || 100)
    .fail(failWithFullHelp)
    .help()
    .parseAsync();

  const since = parseSince(argv.since);
  const { profile, games } = await fetchClockTrackerData();
  const bgStatsPlayerNames = readBgStatsPlayerNames();
  const filteredGames = games.filter(game => clockTrackerDate(game.date) >= since);
  const plays = filteredGames.map(game => toBgStatsPlay(game, profile, bgStatsPlayerNames));

  if (argv.write) {
    if (!Number.isFinite(argv.syncTimeout) || argv.syncTimeout < 1) {
      throw new Error('--sync-timeout must be at least 1 second.');
    }
    writeBgStatsPlays(plays, argv.syncTimeout, argv.database);
    return;
  }
  printOutput(filteredGames, plays, profile, argv.format as OutputFormat);
}

function parseSince(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('--since must be an ISO date in YYYY-MM-DD format.');
  }
  const date = parseISO(value);
  if (!isValid(date) || format(date, 'yyyy-MM-dd') !== value) {
    throw new Error(`Invalid --since date: ${value}`);
  }
  return value;
}

async function fetchClockTrackerData(): Promise<{
  profile: ClockTrackerProfile;
  games: ClockTrackerGame[];
}> {
  const browserGate = browserGatePath();
  await ensureBrowserGateConnection(browserGate);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = getBrowserGateSession(browserGate);
    const headers = sessionHeaders(session);
    try {
      const profile = await fetchJson<ClockTrackerProfile>('/api/settings', headers);
      if (!profile?.user_id || !profile.username || !profile.display_name) {
        throw new Error('ClockTracker returned an unexpected profile response.');
      }
      const personalGames = await fetchJson<ClockTrackerGame[]>(
        `/api/user/${encodeURIComponent(profile.username)}/games`,
        headers,
      );
      const trackedGames = profile.username === TRACKER_USERNAME
        ? personalGames
        : await fetchJson<ClockTrackerGame[]>(
            `/api/user/${encodeURIComponent(TRACKER_USERNAME)}/games`,
            headers,
            60_000,
          );
      if (!Array.isArray(personalGames) || !Array.isArray(trackedGames)) {
        throw new Error('ClockTracker returned an unexpected games response.');
      }
      return {
        profile,
        games: mergeTrackedGames(profile, personalGames, trackedGames),
      };
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message.includes('401 Unauthorized')) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('ClockTracker authentication failed.');
}

function getBrowserGateSession(browserGate: string): BrowserGateSession {
  const session = runBrowserGate(browserGate, [
    'get-session',
    API_BASE_URL,
    '--json',
  ]) as Partial<BrowserGateSession>;

  if (!session.token || !session.tokenType || !session.source) {
    throw new Error('BrowserGate did not return a ClockTracker session.');
  }
  return session as BrowserGateSession;
}

async function ensureBrowserGateConnection(browserGate: string): Promise<void> {
  try {
    runBrowserGate(browserGate, ['tabs', 'list', '--json']);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/extension is not connected|local Browser Gate bridge/iu.test(message)) {
      throw error;
    }
  }

  openChrome(API_BASE_URL);
  if (await waitForBrowserGateConnection(30_000)) {
    return;
  }

  throw new Error(
    'BrowserGate did not connect after Chrome was opened. Enable or reload Browser Gate in chrome://extensions and retry.',
  );
}

function openChrome(url: string): void {
  const result = spawnSync('open', ['-g', '-a', 'Google Chrome', url], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Could not open Google Chrome.');
  }
}

async function waitForBrowserGateConnection(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BROWSER_GATE_HEALTH_URL, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const health = await response.json() as { extensionConnected?: boolean };
        if (health.extensionConnected) {
          return true;
        }
      }
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

function browserGatePath(): string {
  const browserGate = path.resolve(import.meta.dir, '..', '..', 'chrome-browsergate', 'scripts', 'invoke');
  if (!existsSync(browserGate)) {
    throw new Error(`BrowserGate was not found at ${browserGate}.`);
  }
  return browserGate;
}

function runBrowserGate(browserGate: string, args: string[]): unknown {
  const result = spawnSync(process.execPath, [browserGate, ...args], {
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    timeout: 25_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `BrowserGate failed with exit code ${result.status ?? 'unknown'}.`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error('BrowserGate returned invalid JSON.');
  }
}

function mergeTrackedGames(
  profile: ClockTrackerProfile,
  personalGames: ClockTrackerGame[],
  trackedGames: ClockTrackerGame[],
): ClockTrackerGame[] {
  const relevantTrackedGames = trackedGames.filter(game => gameIncludesProfile(game, profile));
  const trackedByFingerprint = new Map(
    relevantTrackedGames.map(game => [gameFingerprint(game), game]),
  );
  const personalFingerprints = new Set(personalGames.map(game => gameFingerprint(game)));
  return [
    ...personalGames.map(game => enrichPersonalGame(game, trackedByFingerprint.get(gameFingerprint(game)))),
    ...relevantTrackedGames
      .filter(game => !personalFingerprints.has(gameFingerprint(game)))
      .map(normalizeTrackedGame),
  ];
}

function enrichPersonalGame(
  game: ClockTrackerGame,
  trackedGame?: ClockTrackerGame,
): ClockTrackerGame {
  if (!trackedGame?.is_storyteller || game.storyteller?.trim()) {
    return game;
  }
  return {
    ...game,
    storyteller: `@${TRACKER_USERNAME}`,
    co_storytellers: [...new Set([...game.co_storytellers, ...trackedGame.co_storytellers])],
  };
}

function normalizeTrackedGame(game: ClockTrackerGame): ClockTrackerGame {
  if (!game.is_storyteller) {
    return game;
  }
  return {
    ...game,
    storyteller: `@${TRACKER_USERNAME}`,
    is_storyteller: false,
  };
}

function gameIncludesProfile(game: ClockTrackerGame, profile: ClockTrackerProfile): boolean {
  const profileNames = new Set([
    normalizeSourceId(profile.display_name),
    normalizeSourceId(profile.username),
  ]);
  const matchesProfile = (value?: string | null) => {
    const normalized = normalizeSourceId(value?.replace(/^@/, '') ?? '');
    return normalized.length > 0 && profileNames.has(normalized);
  };
  if ([game.storyteller, ...game.co_storytellers].some(matchesProfile)) {
    return true;
  }
  return (game.grimoire.at(-1)?.tokens ?? []).some(token => {
    if (token.player_id === profile.user_id) {
      return true;
    }
    return !token.player_id && [
      token.player?.display_name,
      token.player_name,
      token.player?.username,
    ].some(matchesProfile);
  });
}

function gameFingerprint(game: ClockTrackerGame): string {
  const players = [...(game.grimoire.at(-1)?.tokens ?? [])]
    .sort((left, right) => left.order - right.order)
    .map(token => [
      normalizeSourceId(
        token.player?.display_name
          || token.player_name
          || token.player?.username
          || '',
      ),
      normalizeSourceId(token.role?.name ?? ''),
      token.alignment,
    ].join(':'))
    .join('|');
  return [
    clockTrackerDate(game.date),
    normalizeSourceId(game.script),
    normalizeSourceId(game.location),
    game.win_v2,
    players,
  ].join('\0');
}

function readBgStatsPlayerNames(): Map<string, string> {
  const result = spawnSync(process.execPath, [
    '--no-env-file',
    path.join(import.meta.dir, 'bgstats.ts'),
    'read',
    'players',
    '--format=json',
  ], {
    encoding: 'utf8',
    maxBuffer: 10_000_000,
    timeout: 10_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Could not read BG Stats players (exit code ${result.status ?? 'unknown'}).`);
  }

  try {
    const players = JSON.parse(result.stdout) as BgStatsStoredPlayer[];
    if (!Array.isArray(players)) {
      throw new Error('Expected an array.');
    }
    return new Map(players.flatMap(player => player.uuid && player.name ? [[player.uuid, player.name]] : []));
  } catch (error) {
    throw new Error(`Could not parse BG Stats players: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionHeaders(session: BrowserGateSession): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  if (session.tokenType === 'cookie') {
    headers.set('Cookie', session.token);
  } else if (session.tokenType === 'value' && session.source === 'authorization-header') {
    headers.set('Authorization', session.token);
  } else {
    headers.set('Authorization', `Bearer ${session.token}`);
  }
  return headers;
}

async function fetchJson<T>(pathname: string, headers: Headers, timeoutMs = 20_000): Promise<T> {
  const response = await fetch(new URL(pathname, API_BASE_URL), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`ClockTracker request failed: ${response.status} ${response.statusText}`);
  }
  return await response.json() as T;
}

function toBgStatsPlay(
  game: ClockTrackerGame,
  profile: ClockTrackerProfile,
  bgStatsPlayerNames: Map<string, string>,
): BgStatsPlay {
  const players = latestPlayers(game, profile, bgStatsPlayerNames);
  const owner = players.find(player => player.sourcePlayerId === `clocktracker:${profile.user_id}`);
  if (!owner) {
    const fallbackOwner = ownerPlayer(game, profile, bgStatsPlayerNames);
    if (fallbackOwner.role === '_storyteller') {
      players.unshift(fallbackOwner);
    } else {
      players.push(fallbackOwner);
    }
  }

  const locationName = game.location.trim()
    || game.community_name.trim()
    || (game.location_type === 'ONLINE' ? 'Online' : '');
  const location = locationName && game.location_type === 'IN_PERSON'
    ? austinLocationName(locationName)
    : locationName;

  return {
    uuid: BG_STATS_PLAY_UUID_BY_CLOCKTRACKER_ID[game.id],
    sourceName: 'clocktracker.app',
    sourcePlayId: game.id,
    playDate: `${clockTrackerDate(game.date)} 00:00:00`,
    comments: IMPORT_COMMENT,
    board: game.script.trim() || undefined,
    location: location || undefined,
    game: {
      name: 'Blood on the Clocktower',
      sourceGameId: 'clocktracker:blood-on-the-clocktower',
      noPoints: true,
      usesTeams: true,
    },
    players,
  };
}

function writeBgStatsPlays(plays: BgStatsPlay[], syncTimeout: number, databasePath?: string): void {
  if (plays.length === 0) {
    process.stdout.write('No ClockTracker games matched --since; BG Stats was not changed.\n');
    return;
  }
  const args = [
    '--no-env-file',
    path.join(import.meta.dir, 'bgstats.ts'),
    'sync',
    'plays',
    '-',
    '--sync-timeout',
    String(syncTimeout),
  ];
  if (databasePath) {
    args.push('--database', databasePath);
  }
  const orderedPlays = [...plays].sort((left, right) => left.playDate.localeCompare(right.playDate));
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: JSON.stringify(orderedPlays),
    maxBuffer: 10_000_000,
    timeout: syncTimeout * 2_000 + 90_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `BG Stats sync failed with exit code ${result.status ?? 'unknown'}.`);
  }
  process.stdout.write(result.stdout);
}

function latestPlayers(
  game: ClockTrackerGame,
  profile: ClockTrackerProfile,
  bgStatsPlayerNames: Map<string, string>,
): BgStatsPlayer[] {
  const tokens = game.grimoire.at(-1)?.tokens ?? [];
  const seatedPlayers = [...tokens]
    .sort((left, right) => left.order - right.order)
    .flatMap(token => {
      const name = token.player?.display_name?.trim()
        || token.player_name?.trim()
        || token.player?.username?.trim();
      if (!name) {
        return [];
      }
      const sourcePlayerId = token.player_id
        ? `clocktracker:${token.player_id}`
        : participantMatchesProfile(name, profile)
          ? `clocktracker:${profile.user_id}`
          : `clocktracker:name:${normalizeSourceId(name)}`;
      return [{
        ...mappedPlayerIdentity(sourcePlayerId, name, bgStatsPlayerNames),
        sourcePlayerId,
        winner: didAlignmentWin(token.alignment, game.win_v2),
        role: bgStatsRoles(token.alignment, token.role?.type, token.role?.name),
        team: bgStatsTeam(token.alignment),
        teamRole: bgStatsTeamRole(token.alignment),
      }];
    });

  const storytellers: BgStatsPlayer[] = [];
  if (!game.is_storyteller) {
    for (const rawName of [game.storyteller, ...game.co_storytellers]) {
      const name = rawName?.trim();
      if (!name) {
        continue;
      }
      const sourcePlayerId = participantMatchesProfile(name, profile)
        ? `clocktracker:${profile.user_id}`
        : name.startsWith('@')
          ? `clocktracker:username:${normalizeSourceId(name.slice(1))}`
          : `clocktracker:name:${normalizeSourceId(name)}`;
      if (seatedPlayers.some(player => player.sourcePlayerId === sourcePlayerId)) {
        continue;
      }
      storytellers.push({
        ...mappedPlayerIdentity(sourcePlayerId, name.replace(/^@/, ''), bgStatsPlayerNames),
        sourcePlayerId,
        winner: game.win_v2 === 'GOOD_WINS',
        role: '_storyteller',
        team: '0',
        teamRole: 'storyteller',
      });
    }
  }

  return [...storytellers, ...seatedPlayers];
}

function ownerPlayer(
  game: ClockTrackerGame,
  profile: ClockTrackerProfile,
  bgStatsPlayerNames: Map<string, string>,
): BgStatsPlayer {
  const character = game.player_characters.at(-1);
  const alignment = game.is_storyteller ? undefined : character?.alignment;
  const sourcePlayerId = `clocktracker:${profile.user_id}`;
  return {
    ...mappedPlayerIdentity(sourcePlayerId, profile.display_name, bgStatsPlayerNames),
    sourcePlayerId,
    winner: game.is_storyteller
      ? game.win_v2 === 'GOOD_WINS'
      : alignment != null && didAlignmentWin(alignment, game.win_v2),
    role: game.is_storyteller
      ? '_storyteller'
      : bgStatsRoles(alignment, character?.role?.type, character?.name),
    team: game.is_storyteller ? '0' : bgStatsTeam(alignment),
    teamRole: game.is_storyteller ? 'storyteller' : bgStatsTeamRole(alignment),
  };
}

function mappedPlayerIdentity(
  clockTrackerId: string,
  fallbackName: string,
  bgStatsPlayerNames: Map<string, string>,
): Pick<BgStatsPlayer, 'name' | 'uuid'> {
  const newPlayerName = NEW_BG_STATS_PLAYER_NAME_BY_CLOCKTRACKER_ID[clockTrackerId];
  if (newPlayerName) {
    return { name: newPlayerName };
  }
  const uuid = BG_STATS_PLAYER_UUID_BY_CLOCKTRACKER_ID[clockTrackerId];
  if (!uuid) {
    return { name: austinPlayerName(fallbackName) };
  }
  return {
    uuid,
    name: bgStatsPlayerNames.get(uuid) ?? fallbackName,
  };
}

function didAlignmentWin(alignment: Alignment, result: WinStatus): boolean {
  return (alignment === 'GOOD' && result === 'GOOD_WINS')
    || (alignment === 'EVIL' && result === 'EVIL_WINS');
}

function printOutput(
  games: ClockTrackerGame[],
  plays: BgStatsPlay[],
  profile: ClockTrackerProfile,
  outputFormat: OutputFormat,
): void {
  if (outputFormat === 'bgstats') {
    process.stdout.write(`${JSON.stringify(plays, null, 2)}\n`);
    return;
  }

  console.table(games.map((game, index) => {
    const play = plays[index];
    const me = play.players.find(player => player.sourcePlayerId === `clocktracker:${profile.user_id}`);
    return {
      date: clockTrackerDate(game.date),
      script: game.script,
      role: me?.role ?? '',
      team: me?.team === '0' ? 'Storyteller' : me?.team === '1' ? 'Evil' : me?.team === '2' ? 'Good' : '',
      result: game.win_v2 === 'NOT_RECORDED' ? '' : me?.winner ? 'Win' : 'Loss',
      players: play.players.length,
      location: play.location ?? '',
    };
  }));
}

function clockTrackerDate(value: string): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`ClockTracker returned an invalid game date: ${value}`);
  }
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`ClockTracker returned an invalid game date: ${value}`);
  }
  // Austin Saturday sessions recorded after midnight belong to the preceding game day.
  if (parsed.getUTCDay() !== 0) {
    return date;
  }
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function bgStatsRoles(alignment?: string, section?: string, character?: string): string | undefined {
  const roles = character?.trim() ? [character.trim()] : [];
  roles.push(...[alignment, section].flatMap(value => {
    const normalized = value?.trim().toLowerCase();
    return normalized ? [`_${normalized}`] : [];
  }));
  return roles.length > 0 ? roles.join('／') : undefined;
}

function bgStatsTeam(alignment?: Alignment): string | undefined {
  return alignment === 'EVIL' ? '1' : alignment === 'GOOD' ? '2' : undefined;
}

function bgStatsTeamRole(alignment?: Alignment): string | undefined {
  return alignment === 'EVIL' ? 'evil' : alignment === 'GOOD' ? 'good' : undefined;
}

function austinLocationName(value: string): string {
  const name = value.trim();
  return /^🇺🇸\s*Austin:\s*/iu.test(name) ? name : `🇺🇸 Austin: ${name}`;
}

function austinPlayerName(value: string): string {
  const name = value.trim();
  return /\(austin,\s*botc\)$/iu.test(name) ? name : `${name} (austin, botc)`;
}

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, '-');
}

function participantMatchesProfile(value: string, profile: ClockTrackerProfile): boolean {
  const normalized = normalizeSourceId(value.replace(/^@/, ''));
  return normalized === normalizeSourceId(profile.display_name)
    || normalized === normalizeSourceId(profile.username);
}
