#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { format, isValid, parseISO, startOfDay, subDays } from 'date-fns';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import {
  formatDurationMilliseconds,
  formatOffsetDate,
  formatOffsetTime,
} from './utils/date';
import {
  formatDisplayNumber,
  OUTPUT_FORMATS,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputFormat,
} from './utils/output';

const BASE_URL = 'https://api.prod.whoop.com/developer/v2';
const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const MAX_LIMIT = 25;
const DEFAULT_DAYS = 7;
const WHOOP_SCOPE =
  'offline read:profile read:recovery read:sleep read:cycles read:workout read:body_measurement';
const WHOOP_STATE = 'whooppull';
const ENV_LOCAL_PATH = path.resolve(import.meta.dir, '..', '.env.local');
const DAILY_STATS_COLUMNS = [
  'date',
  'strain',
  'recovery',
  'RHR',
  'HRV',
  'activities',
  'sleep_start',
  'sleep_duration',
  'sleep_rem',
  'sleep_deep',
  'sleep_light',
  'sleep_efficiency',
  'sleep_performance',
  'sleep_consistency',
] as const;

const ALL_TYPES = ['profile', 'body', 'cycles', 'recovery', 'sleep', 'workout'] as const;

type DataType = (typeof ALL_TYPES)[number];
type DailyStatsColumn = (typeof DAILY_STATS_COLUMNS)[number];

const TYPE_ALIASES: Record<string, DataType> = {
  profile: 'profile',
  body: 'body',
  body_measurement: 'body',
  measurements: 'body',
  cycle: 'cycles',
  cycles: 'cycles',
  recovery: 'recovery',
  sleep: 'sleep',
  sleeps: 'sleep',
  workout: 'workout',
  workouts: 'workout',
};

interface WhoopCycle {
  id: number;
  start?: string | null;
  end?: string | null;
  timezone_offset?: string | null;
  score?: {
    strain?: number | null;
  } | null;
}

interface WhoopRecovery {
  cycle_id: number;
  sleep_id?: string | null;
  score?: {
    recovery_score?: number | null;
    resting_heart_rate?: number | null;
    hrv_rmssd_milli?: number | null;
  } | null;
}

interface WhoopSleep {
  id: string;
  cycle_id: number;
  start?: string | null;
  end?: string | null;
  timezone_offset?: string | null;
  nap?: boolean | null;
  score?: {
    stage_summary?: {
      total_light_sleep_time_milli?: number | null;
      total_slow_wave_sleep_time_milli?: number | null;
      total_rem_sleep_time_milli?: number | null;
    } | null;
    sleep_efficiency_percentage?: number | null;
    sleep_performance_percentage?: number | null;
    sleep_consistency_percentage?: number | null;
  } | null;
}

interface WhoopWorkout {
  id: string;
  start?: string | null;
  end?: string | null;
  timezone_offset?: string | null;
  sport_name?: string | null;
  score?: {
    strain?: number | null;
  } | null;
}

export interface DailyStatsRow {
  date: string;
  strain: number | null;
  recovery: number | null;
  RHR: number | null;
  HRV: number | null;
  activities: string;
  sleep_start: string;
  sleep_duration: string;
  sleep_rem: string;
  sleep_deep: string;
  sleep_light: string;
  sleep_efficiency: number | null;
  sleep_performance: number | null;
  sleep_consistency: number | null;
}

interface DailyStatsState {
  row: DailyStatsRow;
  activityEntries: { timestamp: number; text: string }[];
  sleepDurationMilli: number;
}

interface CycleState {
  cycle: WhoopCycle;
  rowDate: string;
  row: DailyStatsRow;
  activityEntries: { timestamp: number; text: string }[];
  sleepDurationMilli: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
}

interface FetchOptions {
  accessToken: string;
  start: Date;
  end: Date;
  limit: number;
}

if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  try {
    const args = await yargs(hideBin(process.argv))
      .scriptName('whoop-pull')
      .strict()
      .option('include', {
        alias: ['types', 'what', 'i'],
        type: 'string',
        array: true,
        describe: 'Data types to include (profile, body, cycles, recovery, sleep, workout)',
      })
      .option('exclude', {
        alias: ['x'],
        type: 'string',
        array: true,
        describe: 'Data types to exclude',
      })
      .option('days', {
        alias: ['d'],
        type: 'number',
        default: DEFAULT_DAYS,
        describe: 'Number of complete past days to include when start is not provided',
      })
      .option('start', {
        alias: ['since', 's'],
        type: 'string',
        describe: 'Start time (ISO 8601)',
      })
      .option('end', {
        alias: ['until', 'e'],
        type: 'string',
        describe: 'End time (ISO 8601)',
      })
      .option('limit', {
        alias: ['l'],
        type: 'number',
        default: MAX_LIMIT,
        describe: 'Page size for WHOOP collection endpoints (max 25)',
      })
      .option('format', {
        alias: ['f'],
        type: 'string',
        choices: OUTPUT_FORMATS,
        default: 'table',
        describe: 'Output format',
      })
      .option('auth-code', {
        type: 'string',
        describe:
          'OAuth authorization code copied from the redirect URL after approving access in your browser',
      })
      .option('redirect-uri', {
        type: 'string',
        describe: 'OAuth redirect URI registered in WHOOP Developer Dashboard',
      })
      .option('token', {
        type: 'string',
        describe: 'Manually set WHOOP_REFRESH_TOKEN in .env.local before fetching data',
      })
      .help()
      .parseAsync();

    const providedRefreshToken = normalizeOptionalString(args.token);
    const types = resolveTypes(args.include, args.exclude);
    const { start, end } = resolveRange(args.start, args.end, args.days);
    const limit = resolveLimit(args.limit);
    const format = parseOutputFormat(args.format);

    const clientId = env.WHOOP_CLIENT_ID;
    const clientSecret = env.WHOOP_CLIENT_SECRET;
    const envRedirectUri = normalizeOptionalString(env.WHOOP_REDIRECT_URI);
    const redirectUri = normalizeOptionalString(args['redirect-uri']) ?? envRedirectUri;
    const authCode = normalizeOptionalString(args['auth-code']);
    let refreshToken = providedRefreshToken ?? normalizeOptionalString(env.WHOOP_REFRESH_TOKEN);
    let accessToken: string;

    if (authCode) {
      if (!redirectUri) {
        throw new Error(
          'WHOOP_REDIRECT_URI is not set. Configure it in env-manager or pass --redirect-uri with the URI registered in WHOOP Developer Dashboard.',
        );
      }
      const tokenResponse = await exchangeAuthCodeForTokens({
        clientId,
        clientSecret,
        authCode,
        redirectUri,
      });
      if (!tokenResponse.refresh_token) {
        throw new Error('WHOOP auth-code exchange did not return a refresh token.');
      }
      accessToken = tokenResponse.access_token;
      refreshToken = tokenResponse.refresh_token;
      saveRefreshToken(refreshToken);
    } else if (!refreshToken) {
      if (!redirectUri) {
        throw new Error(
          'WHOOP_REFRESH_TOKEN is not set. Configure WHOOP_REDIRECT_URI in env-manager or pass --redirect-uri so the script can open the WHOOP authorization URL.',
        );
      }
      openAuthorizationUrl(clientId, redirectUri);
      throw new Error(buildManualAuthorizationMessage(clientId, redirectUri));
    } else {
      try {
        const tokenResponse = await refreshAccessToken({
          clientId,
          clientSecret,
          refreshToken,
        });
        accessToken = tokenResponse.access_token;
        saveRefreshToken(tokenResponse.refresh_token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!redirectUri) {
          throw new Error(
            [
              message,
              'The stored WHOOP_REFRESH_TOKEN may be expired, already rotated, or may actually be an access token.',
              'Configure WHOOP_REDIRECT_URI in env-manager or pass --redirect-uri, then reauthorize with `whoop-pull --auth-code <code>`.',
            ].join('\n'),
          );
        }
        openAuthorizationUrl(clientId, redirectUri);
        throw new Error(
          [
            message,
            'The stored WHOOP_REFRESH_TOKEN may be expired, already rotated, or may actually be an access token.',
            'The WHOOP authorization URL has been opened in your default browser.',
            'Approve access, then copy the `code` query parameter from the redirect URL and rerun:',
            '  whoop-pull --auth-code <code>',
          ].join('\n'),
        );
      }
    }

    const data: Partial<Record<DataType, unknown>> = {};
    for (const type of types) {
      data[type] = await fetchType(type, {
        accessToken,
        start,
        end,
        limit,
      });
    }

    const rows = buildDailyStatsRows(data).filter(row =>
      shouldIncludeRow(row.date, {
        startInput: args.start,
        endInput: args.end,
      }),
    );
    renderDailyStatsOutput(rows, format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

export function buildDailyStatsRows(data: Partial<Record<DataType, unknown>>): DailyStatsRow[] {
  const cycleStates = new Map<number, CycleState>();
  const cycleStateList: CycleState[] = [];
  const sleepDateById = new Map<string, string>();
  const extraStates: CycleState[] = [];

  for (const cycle of toCycleRecords(data.cycles)) {
    const rowDate =
      formatOffsetDate(cycle.end, cycle.timezone_offset) ||
      formatOffsetDate(cycle.start, cycle.timezone_offset);
    if (!rowDate) {
      continue;
    }
    const state: CycleState = {
      cycle,
      rowDate,
      row: createEmptyRow(rowDate),
      activityEntries: [],
      sleepDurationMilli: 0,
      startTimestamp: parseTimestamp(cycle.start),
      endTimestamp: parseTimestamp(cycle.end),
    };
    state.row.strain = formatDisplayNumber(cycle.score?.strain ?? null);
    cycleStates.set(cycle.id, state);
    cycleStateList.push(state);
  }

  for (const sleep of toSleepRecords(data.sleep)) {
    if (sleep.nap) {
      continue;
    }
    const cycleState = cycleStates.get(sleep.cycle_id);
    const date =
      formatOffsetDate(sleep.end, sleep.timezone_offset) ||
      cycleState?.rowDate ||
      formatOffsetDate(sleep.start, sleep.timezone_offset);
    if (!date) {
      continue;
    }
    sleepDateById.set(sleep.id, date);
    const stageSummary = sleep.score?.stage_summary;
    const sleepDurationMilli =
      valueOrZero(stageSummary?.total_light_sleep_time_milli) +
      valueOrZero(stageSummary?.total_slow_wave_sleep_time_milli) +
      valueOrZero(stageSummary?.total_rem_sleep_time_milli);
    const state = cycleState ?? createExtraState(extraStates, date);
    state.rowDate = date;
    state.row.date = date;
    if (sleepDurationMilli < state.sleepDurationMilli) {
      continue;
    }
    state.sleepDurationMilli = sleepDurationMilli;
    state.row.sleep_start = formatOffsetTime(sleep.start, sleep.timezone_offset);
    state.row.sleep_duration = formatDurationMilliseconds(sleepDurationMilli);
    state.row.sleep_rem = formatDurationMilliseconds(stageSummary?.total_rem_sleep_time_milli ?? null);
    state.row.sleep_deep = formatDurationMilliseconds(stageSummary?.total_slow_wave_sleep_time_milli ?? null);
    state.row.sleep_light = formatDurationMilliseconds(stageSummary?.total_light_sleep_time_milli ?? null);
    state.row.sleep_efficiency = formatDisplayNumber(sleep.score?.sleep_efficiency_percentage ?? null);
    state.row.sleep_performance = formatDisplayNumber(sleep.score?.sleep_performance_percentage ?? null);
    state.row.sleep_consistency = formatDisplayNumber(sleep.score?.sleep_consistency_percentage ?? null);
  }

  for (const recovery of toRecoveryRecords(data.recovery)) {
    const cycleState = cycleStates.get(recovery.cycle_id);
    const date =
      cycleState?.rowDate ??
      normalizeOptionalString(recovery.sleep_id && sleepDateById.get(recovery.sleep_id));
    if (!date) {
      continue;
    }
    const state = cycleState ?? createExtraState(extraStates, date);
    state.rowDate = date;
    state.row.date = date;
    state.row.recovery = formatDisplayNumber(recovery.score?.recovery_score ?? null);
    state.row.RHR = formatDisplayNumber(recovery.score?.resting_heart_rate ?? null);
    state.row.HRV = formatDisplayNumber(recovery.score?.hrv_rmssd_milli ?? null);
  }

  for (const workout of toWorkoutRecords(data.workout)) {
    const timestamp = parseTimestamp(workout.start);
    if (timestamp == null) {
      continue;
    }
    const cycleState = findCycleStateForTimestamp(cycleStateList, timestamp);
    const date = cycleState?.rowDate || formatOffsetDate(workout.start, workout.timezone_offset);
    if (!date) {
      continue;
    }
    const state = cycleState ?? createExtraState(extraStates, date);
    state.rowDate = date;
    state.row.date = date;
    state.activityEntries.push({
      timestamp,
      text: formatActivity(workout),
    });
  }

  const rowsByDate = new Map<string, DailyStatsState>();
  for (const state of cycleStateList) {
    mergeIntoDateMap(rowsByDate, state);
  }
  for (const state of extraStates) {
    mergeIntoDateMap(rowsByDate, state);
  }

  const rows = Array.from(rowsByDate.values())
    .sort((a, b) => b.row.date.localeCompare(a.row.date))
    .map(state => {
      state.activityEntries.sort((a, b) => a.timestamp - b.timestamp);
      return {
        ...state.row,
        activities: state.activityEntries.map(entry => entry.text).join('\n'),
      };
    });

  return rows;
}

export function renderDailyStatsOutput(rows: DailyStatsRow[], format: OutputFormat): void {
  if (format === 'table') {
    renderTableRecords(toDailyStatsTableRows(rows));
    return;
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderCsvRecords(rows as Record<DailyStatsColumn, CsvValue>[], DAILY_STATS_COLUMNS));
}

export function toDailyStatsTableRows(rows: DailyStatsRow[]): Record<DailyStatsColumn, string | number>[] {
  return rows.map(row => ({
    date: row.date,
    strain: row.strain ?? '',
    recovery: row.recovery ?? '',
    RHR: row.RHR ?? '',
    HRV: row.HRV ?? '',
    activities: row.activities.replaceAll('\n', ' | '),
    sleep_start: row.sleep_start,
    sleep_duration: row.sleep_duration,
    sleep_rem: row.sleep_rem,
    sleep_deep: row.sleep_deep,
    sleep_light: row.sleep_light,
    sleep_efficiency: row.sleep_efficiency ?? '',
    sleep_performance: row.sleep_performance ?? '',
    sleep_consistency: row.sleep_consistency ?? '',
  }));
}

function ensureDailyStatsState(
  rowsByDate: Map<string, DailyStatsState>,
  date: string,
): DailyStatsState {
  const existing = rowsByDate.get(date);
  if (existing) {
    return existing;
  }
  const created: DailyStatsState = {
    row: {
      date,
      strain: null,
      recovery: null,
      RHR: null,
      HRV: null,
      activities: '',
      sleep_start: '',
      sleep_duration: '',
      sleep_rem: '',
      sleep_deep: '',
      sleep_light: '',
      sleep_efficiency: null,
      sleep_performance: null,
      sleep_consistency: null,
    },
    activityEntries: [],
    sleepDurationMilli: 0,
  };
  rowsByDate.set(date, created);
  return created;
}

function createEmptyRow(date: string): DailyStatsRow {
  return {
    date,
    strain: null,
    recovery: null,
    RHR: null,
    HRV: null,
    activities: '',
    sleep_start: '',
    sleep_duration: '',
    sleep_rem: '',
    sleep_deep: '',
    sleep_light: '',
    sleep_efficiency: null,
    sleep_performance: null,
    sleep_consistency: null,
  };
}

function createStandaloneCycleState(date: string): CycleState {
  return {
    cycle: { id: Number.NaN },
    rowDate: date,
    row: createEmptyRow(date),
    activityEntries: [],
    sleepDurationMilli: 0,
    startTimestamp: null,
    endTimestamp: null,
  };
}

function createExtraState(extraStates: CycleState[], date: string): CycleState {
  const state = createStandaloneCycleState(date);
  extraStates.push(state);
  return state;
}

function findCycleStateForTimestamp(cycleStates: CycleState[], timestamp: number): CycleState | null {
  for (const state of cycleStates) {
    if (state.startTimestamp == null) {
      continue;
    }
    if (timestamp < state.startTimestamp) {
      continue;
    }
    if (state.endTimestamp != null && timestamp >= state.endTimestamp) {
      continue;
    }
    return state;
  }
  return null;
}

function mergeIntoDateMap(rowsByDate: Map<string, DailyStatsState>, state: CycleState): void {
  const target = ensureDailyStatsState(rowsByDate, state.rowDate);
  target.sleepDurationMilli = Math.max(target.sleepDurationMilli, state.sleepDurationMilli);
  target.row.strain = firstDefinedNumber(target.row.strain, state.row.strain);
  target.row.recovery = firstDefinedNumber(target.row.recovery, state.row.recovery);
  target.row.RHR = firstDefinedNumber(target.row.RHR, state.row.RHR);
  target.row.HRV = firstDefinedNumber(target.row.HRV, state.row.HRV);
  target.row.sleep_efficiency = firstDefinedNumber(target.row.sleep_efficiency, state.row.sleep_efficiency);
  target.row.sleep_performance = firstDefinedNumber(target.row.sleep_performance, state.row.sleep_performance);
  target.row.sleep_consistency = firstDefinedNumber(target.row.sleep_consistency, state.row.sleep_consistency);
  target.row.sleep_start ||= state.row.sleep_start;
  target.row.sleep_duration ||= state.row.sleep_duration;
  target.row.sleep_rem ||= state.row.sleep_rem;
  target.row.sleep_deep ||= state.row.sleep_deep;
  target.row.sleep_light ||= state.row.sleep_light;
  target.activityEntries.push(...state.activityEntries);
}

function firstDefinedNumber(current: number | null, next: number | null): number | null {
  return current ?? next;
}

function resolveTypes(include: unknown, exclude: unknown): DataType[] {
  const includeList = normalizeTypeList(include);
  const excludeList = normalizeTypeList(exclude);

  if (includeList.length > 0 && excludeList.length > 0) {
    throw new Error('Use either --include or --exclude, not both.');
  }

  const selected =
    includeList.length > 0 ? includeList : ALL_TYPES.filter(type => !excludeList.includes(type));
  if (selected.length === 0) {
    throw new Error('No data types selected. Provide at least one type.');
  }
  return selected;
}

function normalizeTypeList(value: unknown): DataType[] {
  const items = normalizeList(value)
    .map(item => item.toLowerCase())
    .map(item => TYPE_ALIASES[item])
    .filter(Boolean) as DataType[];

  const unknown = normalizeList(value).filter(item => !TYPE_ALIASES[item.toLowerCase()]);
  if (unknown.length > 0) {
    throw new Error(`Unknown data type(s): ${unknown.join(', ')}`);
  }

  return Array.from(new Set(items));
}

function normalizeList(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap(item => String(item).split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveRange(startInput?: string, endInput?: string, daysInput?: number) {
  const end = endInput ? parseDate(endInput, 'end') : startOfDay(new Date());
  const days = daysInput ?? DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('--days must be a positive number.');
  }
  const start = startInput ? parseDate(startInput, 'start') : subDays(end, days);
  if (start > end) {
    throw new Error('Start time must be before end time.');
  }
  return { start, end };
}

function resolveLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('--limit must be a positive number.');
  }
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit exceeds WHOOP maximum of ${MAX_LIMIT}.`);
  }
  return Math.floor(limit);
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return date;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildAuthUrl(clientId: string, redirectUri: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', WHOOP_SCOPE);
  url.searchParams.set('state', WHOOP_STATE);
  return url.toString();
}

function openAuthorizationUrl(clientId: string, redirectUri: string): void {
  const authUrl = buildAuthUrl(clientId, redirectUri);
  const result = spawnSync('open', [authUrl], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`Failed to open browser for WHOOP authorization: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ''}`.trim();
    const stdout = `${result.stdout ?? ''}`.trim();
    throw new Error(
      `Failed to open browser for WHOOP authorization: ${stderr || stdout || `exit code ${result.status}`}`,
    );
  }
}

function buildManualAuthorizationMessage(clientId: string, redirectUri: string): string {
  const authUrl = buildAuthUrl(clientId, redirectUri);
  return [
    'WHOOP_REFRESH_TOKEN is not set.',
    'The WHOOP authorization URL has been opened in your default browser.',
    'Approve access, then copy the `code` query parameter from the redirect URL and rerun:',
    '  whoop-pull --auth-code <code>',
    'If you already have a refresh token, save it directly with:',
    '  whoop-pull --token <refresh-token>',
    '',
    `Auth URL: ${authUrl}`,
  ].join('\n');
}

async function exchangeAuthCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  authCode: string;
  redirectUri: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authCode,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: WHOOP_SCOPE,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`WHOOP auth-code token request failed: ${await formatError(response)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('WHOOP auth-code token response missing access_token.');
  }
  if (!data.refresh_token) {
    throw new Error(
      'WHOOP auth-code token response missing refresh_token. Make sure the app requests offline scope.',
    );
  }

  return data as Required<typeof data> & { access_token: string; refresh_token: string };
}

async function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: 'offline',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`WHOOP refresh-token request failed: ${await formatError(response)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('WHOOP refresh-token response missing access_token.');
  }
  if (!data.refresh_token) {
    throw new Error('WHOOP refresh-token response missing refresh_token.');
  }

  return data as Required<typeof data> & { access_token: string; refresh_token: string };
}

function saveRefreshToken(refreshToken: string): void {
  const assignment = `WHOOP_REFRESH_TOKEN=${quoteEnvValue(refreshToken)} # {optional string}`;
  const current = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const lines = current === '' ? [] : current.split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*WHOOP_REFRESH_TOKEN\s*=/.test(line));

  if (index === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(assignment);
  } else {
    lines[index] = assignment;
  }
  const next = lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(ENV_LOCAL_PATH, next, 'utf8');
  process.env.WHOOP_REFRESH_TOKEN = refreshToken;
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/=-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function fetchType(type: DataType, options: FetchOptions): Promise<unknown> {
  switch (type) {
    case 'profile':
      return fetchJson('/user/profile/basic', options.accessToken);
    case 'body':
      return fetchJson('/user/measurement/body', options.accessToken);
    case 'cycles':
      return fetchCollection('/cycle', options);
    case 'recovery':
      return fetchCollection('/recovery', options);
    case 'sleep':
      return fetchCollection('/activity/sleep', options);
    case 'workout':
      return fetchCollection('/activity/workout', options);
  }
}

async function fetchCollection(pathValue: string, options: FetchOptions): Promise<unknown[]> {
  const records: unknown[] = [];
  let nextToken: string | undefined;
  do {
    const url = buildUrl(pathValue, {
      start: options.start.toISOString(),
      end: options.end.toISOString(),
      limit: options.limit,
      nextToken,
    });
    const page = (await fetchJson(url, options.accessToken)) as {
      records?: unknown[];
      next_token?: string;
      nextToken?: string;
    };
    if (Array.isArray(page.records)) {
      records.push(...page.records);
    }
    nextToken = page.next_token ?? page.nextToken;
  } while (nextToken);
  return records;
}

async function fetchJson(pathOrUrl: string, accessToken: string): Promise<unknown> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`WHOOP request failed: ${await formatError(response)}`);
  }
  return response.json();
}

function buildUrl(pathValue: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(pathValue.startsWith('http') ? pathValue : `${BASE_URL}${pathValue}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function formatError(response: Response): Promise<string> {
  const body = await response.text();
  const snippet = body.trim().slice(0, 500);
  return `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ''}`;
}

function toCycleRecords(value: unknown): WhoopCycle[] {
  return Array.isArray(value) ? value.filter(isWhoopCycle) : [];
}

function toRecoveryRecords(value: unknown): WhoopRecovery[] {
  return Array.isArray(value) ? value.filter(isWhoopRecovery) : [];
}

function toSleepRecords(value: unknown): WhoopSleep[] {
  return Array.isArray(value) ? value.filter(isWhoopSleep) : [];
}

function toWorkoutRecords(value: unknown): WhoopWorkout[] {
  return Array.isArray(value) ? value.filter(isWhoopWorkout) : [];
}

function isWhoopCycle(value: unknown): value is WhoopCycle {
  return isRecord(value) && typeof value.id === 'number';
}

function isWhoopRecovery(value: unknown): value is WhoopRecovery {
  return isRecord(value) && typeof value.cycle_id === 'number';
}

function isWhoopSleep(value: unknown): value is WhoopSleep {
  return isRecord(value) && typeof value.id === 'string' && typeof value.cycle_id === 'number';
}

function isWhoopWorkout(value: unknown): value is WhoopWorkout {
  return isRecord(value) && typeof value.id === 'string';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function formatActivity(workout: WhoopWorkout): string {
  const name = normalizeOptionalString(workout.sport_name) ?? 'workout';
  const strain = formatDisplayNumber(workout.score?.strain ?? null);
  const at = formatOffsetTime(workout.start, workout.timezone_offset);
  const duration = formatDurationMilliseconds(durationBetween(workout.start, workout.end));
  const details = [at ? `at ${at}` : '', duration ? `for ${duration}` : ''].filter(Boolean);
  if (details.length === 0) {
    return name;
  }
  if (strain == null) {
    return `${name} ${details.join(' ')}`;
  }
  return `${name}: ${strain} strain ${details.join(' ')}`;
}

function durationBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const startTimestamp = parseTimestamp(start);
  const endTimestamp = parseTimestamp(end);
  if (startTimestamp == null || endTimestamp == null || endTimestamp < startTimestamp) {
    return null;
  }
  return endTimestamp - startTimestamp;
}

function valueOrZero(value: number | null | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed.getTime() : null;
}

function shouldIncludeRow(
  date: string,
  options: {
    startInput?: string;
    endInput?: string;
  },
): boolean {
  if (options.startInput || options.endInput) {
    return true;
  }
  return date < format(startOfDay(new Date()), 'yyyy-MM-dd');
}
