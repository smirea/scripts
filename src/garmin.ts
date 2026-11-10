#!/usr/bin/env bun
import { createScript } from './utils/createScript';

import { addDays, format, isValid, parseISO } from 'date-fns';

import env from './env';
import { formatDurationMilliseconds } from './utils/date';
import { OUTPUT_FORMATS, parseOutputFormat, renderCsvRecords, renderTableRecords, type CsvValue } from './utils/output';

const BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken';
const SWAGGER_PAGE = 'https://developer.garmin.com/gc-developer-program/personal/swagger-docs/';
// The tightest range cap in the spec (steps and stress); sleep and Body Battery allow 31, daily summaries a year.
const MAX_RANGE_DAYS = 28;
const ACTIVITY_PAGE_SIZE = 100;

const TABLE_COLUMNS = [
  'date',
  'sleep_score',
  'sleep_start',
  'sleep_duration',
  'sleep_deep',
  'sleep_light',
  'sleep_rem',
  'sleep_awake',
  'HRV',
  'HRV_7d',
  'hrv_status',
  'RHR',
  'bb_high',
  'bb_low',
  'stress',
  'respiration',
  'spo2',
  'steps',
  'activities',
] as const;

const FULL_COLUMNS = [
  ...TABLE_COLUMNS,
  'sleep_end',
  'sleep_need',
  'sleep_hr',
  'sleep_respiration',
  'sleep_spo2',
  'sleep_stress',
  'awake_count',
  'nap_duration',
  'bb_charged',
  'bb_drained',
  'stress_max',
  'active_kcal',
  'total_kcal',
  'intensity_moderate',
  'intensity_vigorous',
  'floors',
] as const;

type Column = (typeof FULL_COLUMNS)[number];
type DailyRow = Record<Column, CsvValue>;

interface SleepScoreItem {
  value?: number | null;
}

interface DailySleep {
  calendarDate: string;
  sleepTimeSeconds?: number | null;
  napTimeSeconds?: number | null;
  sleepStartTimestampLocal?: string | number | null;
  sleepEndTimestampLocal?: string | number | null;
  deepSleepSeconds?: number | null;
  lightSleepSeconds?: number | null;
  remSleepSeconds?: number | null;
  awakeSleepSeconds?: number | null;
  awakeCount?: number | null;
  avgHeartRate?: number | null;
  averageRespirationValue?: number | null;
  averageSpO2Value?: number | null;
  avgSleepStress?: number | null;
  sleepScores?: Record<string, SleepScoreItem | undefined> | null;
  sleepNeed?: { actual?: number | null } | null;
}

interface HrvSummary {
  calendarDate: string;
  weeklyAvg?: number | null;
  lastNightAvg?: number | null;
  status?: string | null;
}

interface DailySummary {
  calendarDate: string;
  movement?: { steps?: { value?: number | null } | null; floorsAscended?: { value?: number | null } | null } | null;
  calories?: { burnedActive?: number | null; burnedTotal?: number | null } | null;
  heartRate?: { restingValue?: number | null } | null;
  intensityMinutes?: { moderate?: number | null; vigorous?: number | null } | null;
  stress?: { avgLevel?: number | null; maxLevel?: number | null } | null;
  bodyBattery?: {
    minValue?: number | null;
    maxValue?: number | null;
    chargedValue?: number | null;
    drainedValue?: number | null;
  } | null;
  respiration?: { avgValue?: number | null } | null;
  pulseOx?: { avgValue?: number | null } | null;
}

interface Activity {
  activityName?: string | null;
  startTimeLocal?: string | null;
  duration?: number | null;
  activityType?: { typeKey?: string | null } | null;
}

class GarminClient {
  private constructor(private readonly token: string) {}

  static async connect(apiKey: string): Promise<GarminClient> {
    const res = await fetch(BASE_URL + TOKEN_PATH, {
      method: 'POST',
      headers: { Accept: '*/*', Authorization: `ApiKey ${apiKey}` },
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Garmin rejected GARMIN_PERSONAL_API_KEY (${res.status}); it may be expired or deleted. Create a new key at ${KEY_PAGE}, put it in .env.local, and run \`env-manager up\`.`,
      );
    }
    if (!res.ok) throw new Error(`POST ${TOKEN_PATH} failed with ${res.status}: ${body.slice(0, 300)}`);
    return new GarminClient(body.trim());
  }

  async get<T>(pathname: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(pathname, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` } });
    const body = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 404
          ? ` The Personal API only serves the paths listed in ${SWAGGER_PAGE}.`
          : res.status === 400
            ? ' Check the dates (YYYY-MM-DD) and the per-endpoint range cap in the Swagger docs.'
            : '';
      throw new Error(`GET ${url.pathname}${url.search} failed with ${res.status}: ${body.slice(0, 300)}${hint}`);
    }
    return (body ? JSON.parse(body) : null) as T;
  }
}

function requireApiKey(): string {
  const key = env.GARMIN_PERSONAL_API_KEY;
  if (!key) {
    throw new Error(
      `GARMIN_PERSONAL_API_KEY is not set. Create a key at ${KEY_PAGE}, add GARMIN_PERSONAL_API_KEY='<key>' to .env.local, and run \`env-manager up\`.`,
    );
  }
  return key;
}

function parseDay(value: string, flag: string): Date {
  const date = parseISO(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isValid(date)) throw new Error(`--${flag} must be a YYYY-MM-DD date, got '${value}'.`);
  return date;
}

function resolveRange(args: { start?: string; end?: string; days: number }): { start: Date; end: Date } {
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error(`--days must be a positive integer, got ${args.days}.`);
  const end = args.end ? parseDay(args.end, 'end') : new Date();
  const start = args.start ? parseDay(args.start, 'start') : addDays(end, 1 - args.days);
  if (start > end) throw new Error(`--start ${format(start, 'yyyy-MM-dd')} is after --end ${format(end, 'yyyy-MM-dd')}.`);
  return { start, end };
}

function chunkRange(start: Date, end: Date): [string, string][] {
  const chunks: [string, string][] = [];
  for (let from = start; from <= end; from = addDays(from, MAX_RANGE_DAYS)) {
    const to = addDays(from, MAX_RANGE_DAYS - 1);
    chunks.push([format(from, 'yyyy-MM-dd'), format(to > end ? end : to, 'yyyy-MM-dd')]);
  }
  return chunks;
}

async function fetchActivities(client: GarminClient, startDate: string, endDate: string): Promise<Activity[]> {
  const activities: Activity[] = [];
  for (let start = 0; ; start += ACTIVITY_PAGE_SIZE) {
    const page = await client.get<Activity[]>('/activitylist-service/activities/search/activities', {
      start,
      limit: ACTIVITY_PAGE_SIZE,
      startDate,
      endDate,
    });
    activities.push(...page);
    if (page.length < ACTIVITY_PAGE_SIZE) return activities;
  }
}

async function fetchDaily(client: GarminClient, start: Date, end: Date) {
  const chunks = await Promise.all(
    chunkRange(start, end).map(async ([from, to]) => {
      const [summaries, sleeps, hrv, activities] = await Promise.all([
        client.get<{ data?: DailySummary[] | null }>('/usersummary-service/v2/dailysummaries', { startDate: from, endDate: to }),
        client.get<DailySleep[] | null>('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: from, endDate: to }),
        client.get<{ hrvSummaries?: HrvSummary[] | null }>(`/hrv-service/hrv/daily/${from}/${to}`),
        fetchActivities(client, from, to),
      ]);
      return {
        summaries: summaries?.data ?? [],
        sleeps: sleeps ?? [],
        hrv: hrv?.hrvSummaries ?? [],
        activities,
      };
    }),
  );
  return {
    summaries: chunks.flatMap(chunk => chunk.summaries),
    sleeps: chunks.flatMap(chunk => chunk.sleeps),
    hrv: chunks.flatMap(chunk => chunk.hrv),
    activities: chunks.flatMap(chunk => chunk.activities),
  };
}

// The spec types "Local" sleep timestamps as date-time but describes them as ms: either local wall time without an offset,
// or epoch ms shifted by the user's UTC offset so the UTC fields read as local wall time.
function formatLocalClock(value: string | number | null | undefined): CsvValue {
  if (value == null || value === '') return null;
  const wallClock = typeof value === 'string' ? /T(\d{2}:\d{2})/.exec(value) : null;
  if (wallClock) return wallClock[1]!;
  const date = new Date(Number(value));
  if (!isValid(date)) return null;
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

const seconds = (value: number | null | undefined): CsvValue => formatDurationMilliseconds(value == null ? null : value * 1000) || null;

function emptyRow(date: string): DailyRow {
  return Object.fromEntries(FULL_COLUMNS.map(column => [column, column === 'date' ? date : null])) as DailyRow;
}

function buildRows(data: Awaited<ReturnType<typeof fetchDaily>>, start: Date, end: Date): DailyRow[] {
  const rows = new Map<string, DailyRow>();
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const date = format(day, 'yyyy-MM-dd');
    rows.set(date, emptyRow(date));
  }
  const rowFor = (date: string) => rows.get(date);

  for (const sleep of data.sleeps) {
    const row = rowFor(sleep.calendarDate);
    if (!row) continue;
    Object.assign(row, {
      sleep_score: sleep.sleepScores?.overall?.value ?? null,
      sleep_start: formatLocalClock(sleep.sleepStartTimestampLocal),
      sleep_end: formatLocalClock(sleep.sleepEndTimestampLocal),
      sleep_duration: seconds(sleep.sleepTimeSeconds),
      sleep_deep: seconds(sleep.deepSleepSeconds),
      sleep_light: seconds(sleep.lightSleepSeconds),
      sleep_rem: seconds(sleep.remSleepSeconds),
      sleep_awake: seconds(sleep.awakeSleepSeconds),
      sleep_need: sleep.sleepNeed?.actual == null ? null : formatDurationMilliseconds(sleep.sleepNeed.actual * 60_000),
      sleep_hr: sleep.avgHeartRate ?? null,
      sleep_respiration: sleep.averageRespirationValue ?? null,
      sleep_spo2: sleep.averageSpO2Value ?? null,
      sleep_stress: sleep.avgSleepStress ?? null,
      awake_count: sleep.awakeCount ?? null,
      nap_duration: seconds(sleep.napTimeSeconds),
    } satisfies Partial<DailyRow>);
  }

  for (const hrv of data.hrv) {
    const row = rowFor(hrv.calendarDate);
    if (!row) continue;
    Object.assign(row, {
      HRV: hrv.lastNightAvg ?? null,
      HRV_7d: hrv.weeklyAvg ?? null,
      hrv_status: hrv.status?.toLowerCase() ?? null,
    } satisfies Partial<DailyRow>);
  }

  for (const summary of data.summaries) {
    const row = rowFor(summary.calendarDate);
    if (!row) continue;
    Object.assign(row, {
      RHR: summary.heartRate?.restingValue ?? null,
      bb_high: summary.bodyBattery?.maxValue ?? null,
      bb_low: summary.bodyBattery?.minValue ?? null,
      bb_charged: summary.bodyBattery?.chargedValue ?? null,
      bb_drained: summary.bodyBattery?.drainedValue ?? null,
      stress: summary.stress?.avgLevel ?? null,
      stress_max: summary.stress?.maxLevel ?? null,
      respiration: summary.respiration?.avgValue ?? null,
      spo2: summary.pulseOx?.avgValue ?? null,
      steps: summary.movement?.steps?.value ?? null,
      floors: summary.movement?.floorsAscended?.value ?? null,
      active_kcal: summary.calories?.burnedActive ?? null,
      total_kcal: summary.calories?.burnedTotal ?? null,
      intensity_moderate: summary.intensityMinutes?.moderate ?? null,
      intensity_vigorous: summary.intensityMinutes?.vigorous ?? null,
    } satisfies Partial<DailyRow>);
  }

  const activitiesByDate = new Map<string, string[]>();
  const sortedActivities = data.activities.toSorted((a, b) => (a.startTimeLocal ?? '').localeCompare(b.startTimeLocal ?? ''));
  for (const activity of sortedActivities) {
    const date = activity.startTimeLocal?.slice(0, 10);
    if (!date || !rows.has(date)) continue;
    const name = activity.activityName || activity.activityType?.typeKey || 'activity';
    const duration = seconds(activity.duration);
    activitiesByDate.set(date, [...(activitiesByDate.get(date) ?? []), duration ? `${name} (${duration})` : name]);
  }
  for (const [date, entries] of activitiesByDate) rows.get(date)!.activities = entries.join('; ');

  return [...rows.values()].toReversed();
}

const cli = createScript('garmin')
  .usage(
    [
      '$0 <command>',
      '',
      `Pulls your Garmin Connect data (any Garmin device, including the CIRQA band) through Garmin's official Personal API.`,
      `Auth: GARMIN_PERSONAL_API_KEY, created at ${KEY_PAGE} (expires after 30 days to 1 year).`,
    ].join('\n'),
  )
  .command(
    ['daily', '$0'],
    'One row per day: sleep, HRV, resting HR, Body Battery, stress, respiration, SpO2, steps, and activities',
    cli =>
      cli
        .option('days', { alias: 'd', type: 'number', default: 7, describe: 'Days to include, ending at --end, when --start is not given' })
        .option('start', { alias: ['since', 's'], type: 'string', describe: 'First day (YYYY-MM-DD)' })
        .option('end', { alias: ['until', 'e'], type: 'string', describe: 'Last day (YYYY-MM-DD), default today' })
        .option('format', {
          alias: 'f',
          type: 'string',
          choices: OUTPUT_FORMATS,
          default: 'table',
          describe: 'table and csv show the main columns; json and csv:full add sleep detail, calories, intensity minutes, and floors',
        }),
    async argv => {
      const apiKey = requireApiKey();
      const outputFormat = parseOutputFormat(argv.format);
      const { start, end } = resolveRange(argv);
      const client = await GarminClient.connect(apiKey);
      const rows = buildRows(await fetchDaily(client, start, end), start, end);
      if (outputFormat === 'table') {
        renderTableRecords(rows.map(row => Object.fromEntries(TABLE_COLUMNS.map(column => [column, row[column] ?? '']))));
      } else if (outputFormat === 'json') {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        process.stdout.write(renderCsvRecords(rows, outputFormat === 'csv:full' ? FULL_COLUMNS : TABLE_COLUMNS));
      }
    },
  )
  .command(
    'raw <path>',
    `GET any Personal API endpoint and print its JSON. Paths and range caps: ${SWAGGER_PAGE}`,
    cli =>
      cli
        .positional('path', {
          type: 'string',
          demandOption: true,
          describe: 'Endpoint path, e.g. /sleep-service/sleep/dailySleep or /hrv-service/hrv/2026-11-08',
        })
        .option('param', {
          alias: 'p',
          type: 'string',
          array: true,
          default: [],
          describe: 'Query parameter as key=value, repeatable (e.g. -p date=2026-11-08)',
        })
        .example('$0 raw /sleep-service/sleep/dailySleep -p date=2026-11-08', 'Full sleep record, including stage timeline and sleep score components')
        .example('$0 raw /wellness-service/wellness/dailyHeartRate -p date=2026-11-08', 'Heart rate samples for one day')
        .example('$0 raw /wellness-service/wellness/bodyBattery/reports/daily -p startDate=2026-11-01 -p endDate=2026-11-08', 'Body Battery samples and events')
        .example('$0 raw /usersummary-service/v2/dailysummaries -p startDate=2026-11-01 -p endDate=2026-11-08', 'Daily summaries, up to a year per call')
        .example('$0 raw /fitnessage-service/fitnessage/v2/2026-11-08', 'Fitness age')
        .example('$0 raw /userprofile-service/userprofile/settings', 'Profile, including VO2 max and lactate threshold'),
    async argv => {
      const apiKey = requireApiKey();
      const params = Object.fromEntries(
        argv.param.map(pair => {
          const separator = pair.indexOf('=');
          if (separator <= 0) throw new Error(`--param must look like key=value, got '${pair}'.`);
          return [pair.slice(0, separator), pair.slice(separator + 1)];
        }),
      );
      const path = argv.path.startsWith('/') ? argv.path : `/${argv.path}`;
      const client = await GarminClient.connect(apiKey);
      process.stdout.write(`${JSON.stringify(await client.get(path, params), null, 2)}\n`);
    },
  );

await cli.parseAsync();
