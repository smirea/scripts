#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { format, isValid, parseISO, subDays } from 'date-fns';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const API_BASE_URL = 'https://clocktracker.app';
const OUTPUT_FORMATS = ['bgstats', 'table'] as const;

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
}

interface ClockTrackerToken {
  order: number;
  player_id: string | null;
  player_name: string;
  alignment: Alignment;
  role?: {
    name: string;
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
  name: string;
  sourcePlayerId: string;
  winner: boolean;
  role?: string;
  team?: string;
}

interface BgStatsPlay {
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
    .example('$0 --since 2026-07-01', 'Read games since July 1 as BG Stats JSON.')
    .example('$0 --format table', 'Show games from the past week in a table.')
    .strict()
    .showHelpOnFail(false)
    .wrap(process.stdout.columns || 100)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .help()
    .parseAsync();

  const since = parseSince(argv.since);
  const { profile, games } = await fetchClockTrackerData();
  const filteredGames = games.filter(game => clockTrackerDate(game.date) >= since);
  const plays = filteredGames.map(game => toBgStatsPlay(game, profile));

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
  const session = getBrowserGateSession();
  const headers = sessionHeaders(session);
  const profile = await fetchJson<ClockTrackerProfile>('/api/settings', headers);
  if (!profile?.user_id || !profile.username || !profile.display_name) {
    throw new Error('ClockTracker returned an unexpected profile response.');
  }
  const games = await fetchJson<ClockTrackerGame[]>(
    `/api/user/${encodeURIComponent(profile.username)}/games`,
    headers,
  );
  if (!Array.isArray(games)) {
    throw new Error('ClockTracker returned an unexpected games response.');
  }
  return { profile, games };
}

function getBrowserGateSession(): BrowserGateSession {
  const browserGate = browserGatePath();
  const tabs = runBrowserGate(browserGate, ['tabs', 'list', '--json']) as {
    tabs?: Array<{ url?: string }>;
  };
  const clockTrackerTab = tabs.tabs?.find(tab => {
    try {
      return new URL(tab.url ?? '').hostname === 'clocktracker.app';
    } catch {
      return false;
    }
  });
  const session = runBrowserGate(browserGate, [
    'get-session',
    clockTrackerTab?.url ?? API_BASE_URL,
    '--json',
  ]) as Partial<BrowserGateSession>;

  if (!session.token || !session.tokenType || !session.source) {
    throw new Error('BrowserGate did not return a ClockTracker session.');
  }
  return session as BrowserGateSession;
}

function browserGatePath(): string {
  const browserGate = path.resolve(import.meta.dir, '..', '..', 'chrome-browsergate', 'scripts', 'invoke');
  if (!existsSync(browserGate)) {
    throw new Error(`BrowserGate was not found at ${browserGate}.`);
  }
  return browserGate;
}

function runBrowserGate(browserGate: string, args: string[]): unknown {
  const result = spawnSync(browserGate, args, {
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

async function fetchJson<T>(pathname: string, headers: Headers): Promise<T> {
  const response = await fetch(new URL(pathname, API_BASE_URL), {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`ClockTracker request failed: ${response.status} ${response.statusText}`);
  }
  return await response.json() as T;
}

function toBgStatsPlay(game: ClockTrackerGame, profile: ClockTrackerProfile): BgStatsPlay {
  const players = latestPlayers(game);
  const owner = players.find(player => player.sourcePlayerId === `clocktracker:${profile.user_id}`);
  if (!owner) {
    players.unshift(ownerPlayer(game, profile));
  }

  const location = game.location.trim()
    || game.community_name.trim()
    || (game.location_type === 'ONLINE' ? 'Online' : '');

  return {
    sourceName: 'clocktracker.app',
    sourcePlayId: game.id,
    playDate: `${clockTrackerDate(game.date)} 00:00:00`,
    comments: game.notes.trim() || undefined,
    board: game.script.trim() || undefined,
    location: location || undefined,
    game: {
      name: 'Blood on the Clocktower',
      sourceGameId: 'clocktracker:blood-on-the-clocktower',
      noPoints: true,
    },
    players,
  };
}

function latestPlayers(game: ClockTrackerGame): BgStatsPlayer[] {
  const tokens = game.grimoire.at(-1)?.tokens ?? [];
  return [...tokens]
    .sort((left, right) => left.order - right.order)
    .flatMap(token => {
      const name = token.player?.display_name?.trim()
        || token.player_name?.trim()
        || token.player?.username?.trim();
      if (!name) {
        return [];
      }
      return [{
        name,
        sourcePlayerId: token.player_id
          ? `clocktracker:${token.player_id}`
          : `clocktracker:name:${normalizeSourceId(name)}`,
        winner: didAlignmentWin(token.alignment, game.win_v2),
        role: token.role?.name || undefined,
        team: titleCase(token.alignment),
      }];
    });
}

function ownerPlayer(game: ClockTrackerGame, profile: ClockTrackerProfile): BgStatsPlayer {
  const character = game.player_characters.at(-1);
  const alignment = game.is_storyteller ? undefined : character?.alignment;
  return {
    name: profile.display_name,
    sourcePlayerId: `clocktracker:${profile.user_id}`,
    winner: game.is_storyteller
      ? game.win_v2 === 'GOOD_WINS'
      : alignment != null && didAlignmentWin(alignment, game.win_v2),
    role: game.is_storyteller ? 'Storyteller' : character?.name || undefined,
    team: game.is_storyteller ? 'Storyteller' : alignment ? titleCase(alignment) : undefined,
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
      team: me?.team ?? '',
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
  return date;
}

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, '-');
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
