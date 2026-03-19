#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import {
  OUTPUT_FORMATS,
  formatDisplayNumber,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputFormat,
} from './utils/output';

const SOURCE_PATH = 'api://macrofactor/food-log';
const FIREBASE_WEB_API_KEY = 'AIzaSyA17Uwy37irVEQSwz6PIyX3wnkHrDBeleA';
const FIREBASE_PROJECT_ID = 'sbs-diet-app';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const IOS_BUNDLE_ID = 'com.sbs.diet';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const FOOD_DOC_BATCH_SIZE = 10;
export const APPLE_REFERENCE_UNIX_SECONDS = 978307200;
const SECONDS_PER_DAY = 24 * 60 * 60;
const CSV_COLUMNS = [
  'date',
  'time',
  'name',
  'serving',
  'servingGrams',
  'calories',
  'protein',
  'carbs',
  'fat',
  'fiber',
] as const;
const DAILY_OVERVIEW_COLUMNS = [
  'date',
  'weightKg',
  'calories',
  'carbs',
  'protein',
  'fat',
  'fiber',
  'goal_calories',
  'goal_protein',
  'goal_carbs',
  'goal_fat',
  'foods_logged',
] as const;
const RECIPE_BREAKDOWN_COLUMNS = ['name', 'ingredients', 'nutrition', 'consumed_on'] as const;
const FULL_BASE_COLUMNS = ['date', 'time', 'name', 'serving', 'servingGrams'] as const;
const CODE_NAME_MAP: Record<string, string> = {
  a: 'alcohol_g',
  c: 'carbs_g',
  e: 'fiber_g',
  f: 'fat_g',
  k: 'calories_kcal',
  nc: 'net_carbs_g',
  p: 'protein_g',
  s: 'sugars_g',
  ea: 'added_sugars_g',
};
const NUTRIENT_CODE_NAME_MAP: Record<string, string> = {
  a: 'alcohol_g',
  c: 'carbs_g',
  e: 'fiber_g',
  ea: 'added_sugars_g',
  f: 'fat_g',
  k: 'calories_kcal',
  nc: 'net_carbs_g',
  p: 'protein_g',
  s: 'sugars_g',
  '209': 'starch_g',
  '221': 'alcohol_g',
  '255': 'water_g',
  '262': 'caffeine_mg',
  '263': 'theobromine_mg',
  '269': 'sugars_g',
  '291': 'fiber_g',
  '301': 'calcium_mg',
  '303': 'iron_mg',
  '304': 'magnesium_mg',
  '305': 'phosphorus_mg',
  '306': 'potassium_mg',
  '307': 'sodium_mg',
  '309': 'zinc_mg',
  '312': 'copper_mg',
  '315': 'manganese_mg',
  '317': 'selenium_ug',
  '320': 'vitamin_a_ug_rae',
  '323': 'vitamin_e_mg',
  '328': 'vitamin_d_ug',
  '401': 'vitamin_c_mg',
  '404': 'thiamin_mg',
  '405': 'riboflavin_mg',
  '406': 'niacin_mg',
  '410': 'pantothenic_acid_mg',
  '415': 'vitamin_b6_mg',
  '417': 'folate_total_ug',
  '418': 'vitamin_b12_ug',
  '421': 'choline_mg',
  '430': 'vitamin_k_ug',
  '501': 'tryptophan_g',
  '502': 'threonine_g',
  '503': 'isoleucine_g',
  '504': 'leucine_g',
  '505': 'lysine_g',
  '506': 'methionine_g',
  '507': 'cystine_g',
  '508': 'phenylalanine_g',
  '509': 'tyrosine_g',
  '510': 'valine_g',
  '512': 'histidine_g',
  '539': 'added_sugars_g',
  '601': 'cholesterol_mg',
  '606': 'saturated_fat_g',
  '621': 'dha_g',
  '629': 'epa_g',
  '645': 'monounsaturated_fat_g',
  '646': 'polyunsaturated_fat_g',
};
const PREFERRED_NUTRIENT_ORDER = [
  'calories_kcal',
  'protein_g',
  'carbs_g',
  'fat_g',
  'fiber_g',
  'sugars_g',
  'added_sugars_g',
  'net_carbs_g',
  'alcohol_g',
  'water_g',
  'sodium_mg',
  'potassium_mg',
  'calcium_mg',
  'iron_mg',
  'magnesium_mg',
  'phosphorus_mg',
  'zinc_mg',
  'copper_mg',
  'manganese_mg',
  'selenium_ug',
  'cholesterol_mg',
  'saturated_fat_g',
  'monounsaturated_fat_g',
  'polyunsaturated_fat_g',
  'dha_g',
  'epa_g',
  'starch_g',
  'caffeine_mg',
  'theobromine_mg',
  'vitamin_a_ug_rae',
  'vitamin_c_mg',
  'vitamin_d_ug',
  'vitamin_e_mg',
  'vitamin_k_ug',
  'thiamin_mg',
  'riboflavin_mg',
  'niacin_mg',
  'pantothenic_acid_mg',
  'vitamin_b6_mg',
  'folate_total_ug',
  'vitamin_b12_ug',
  'choline_mg',
  'tryptophan_g',
  'threonine_g',
  'isoleucine_g',
  'leucine_g',
  'lysine_g',
  'methionine_g',
  'cystine_g',
  'phenylalanine_g',
  'tyrosine_g',
  'valine_g',
  'histidine_g',
] as const;

interface FirebaseSession {
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
  userId: string;
}

interface FirestoreDocumentResponse {
  fields?: Record<string, unknown>;
}

interface FirebaseSignInResponse {
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  localId?: string;
}

interface FirebaseRefreshResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
}

interface BuildApiReportOptions {
  sourcePath: string;
  dayDocuments: ApiFoodLogDay[];
  customFoodDetails?: Record<string, CustomFoodDetails>;
  programTargets?: ProgramTarget[];
  scaleWeights?: Record<string, number>;
  days: number;
  start?: string;
  end?: string;
  limit?: number;
  nowUnixSeconds?: number;
}

export interface ApiFoodLogDay {
  date: string;
  document: Record<string, unknown> | null;
}

interface ParsedFoodLogEntry {
  groupKey: string;
  itemId: string;
  title: string;
  brandName: string | null;
  source: string | null;
  isCustom: boolean;
  kind: MacrofactorFoodRecord['kind'];
  recipeId: string | null;
  timestampMs: number;
  consumedDate: string;
  serving: string;
  servingGrams: number | null;
  nutrition: MacrofactorFoodRecord['nutrition'];
}

interface CustomFoodDetails {
  kind: MacrofactorFoodRecord['kind'];
  recipeId: string | null;
  ingredients: string[];
}

interface ProgramTarget {
  effectiveDate: string;
  calories: Array<number | null>;
  protein: Array<number | null>;
  carbs: Array<number | null>;
  fat: Array<number | null>;
}

export interface MacrofactorReport {
  generatedAt: string;
  sourcePath: string;
  window: {
    start: string;
    end: string;
  };
  matchedFoods: number;
  returnedFoods: number;
  dailyOverview: MacrofactorDailyOverviewRecord[];
  foods: MacrofactorFoodRecord[];
  recipeBreakdown: MacrofactorRecipeBreakdownRecord[];
}

export interface MacrofactorFoodRecord {
  itemId: string;
  title: string;
  brandName: string | null;
  source: string | null;
  isCustom: boolean;
  kind: 'food' | 'recipe';
  recipeId: string | null;
  firstConsumedAt: string | null;
  latestConsumedAt: string;
  serving: string;
  servingGrams: number | null;
  nutrition: {
    caloriesKcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
    sugarG: number | null;
    netCarbsG: number | null;
    alcoholG: number | null;
    byCode: Record<string, number>;
    named: Record<string, number>;
  };
}

export interface MacrofactorDailyOverviewRecord {
  date: string;
  weightKg: number | null;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  fiber: number;
  goal_calories: number | null;
  goal_protein: number | null;
  goal_carbs: number | null;
  goal_fat: number | null;
  foods_logged: number;
}

export interface MacrofactorRecipeBreakdownRecord {
  recipeId: string;
  name: string;
  ingredients: string[];
  nutrition: MacrofactorFoodRecord['nutrition'];
  consumed_on: string[];
}

export interface MacrofactorConciseRow {
  date: string;
  time: string;
  name: string;
  serving: string;
  servingGrams: number | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
}

export interface ResolvedWindow {
  startUnixSeconds: number;
  endUnixSeconds: number;
}

type ConciseDateFormat = 'iso' | 'table' | 'csv';

if (import.meta.main) {
  void runCli();
}

export function renderOutput(options: {
  report: MacrofactorReport;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
  full?: boolean;
}): void {
  const full = options.full ?? false;
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    renderTable(options.report, { full });
    return;
  }

  const text = (() => {
    if (options.format === 'json') {
      return `${JSON.stringify(serializeReport(options.report, { full }), null, options.pretty ? 2 : 0)}\n`;
    }
    if (options.format === 'csv:full') {
      return renderFullCsv(options.report, { full });
    }
    if (!full) {
      return renderCsv(toConciseRows(options.report, { dateFormat: 'csv' }));
    }
    const fullRows = toFullRows(options.report, { dateFormat: 'csv' });
    return renderCsvRecords(fullRows.rows, fullRows.columns);
  })();

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
}

export function serializeReport(
  report: MacrofactorReport,
  _options?: { full?: boolean }
): Record<string, unknown> {
  return {
    ...report,
    dailyOverview: report.dailyOverview,
    foods: report.foods.map(food => ({
      itemId: food.itemId,
      title: food.title,
      brandName: food.brandName,
      source: food.source,
      isCustom: food.isCustom,
      kind: food.kind,
      recipeId: food.recipeId,
      firstConsumedAt: food.firstConsumedAt,
      latestConsumedAt: food.latestConsumedAt,
      serving: food.serving,
      servingGrams: food.servingGrams,
      nutrition: flattenNamedNutrients(food.nutrition),
    })),
    recipeBreakdown: report.recipeBreakdown.map(recipe => ({
      recipeId: recipe.recipeId,
      name: recipe.name,
      ingredients: [...recipe.ingredients],
      nutrition: formatNutritionLines(recipe.nutrition),
      consumed_on: [...recipe.consumed_on],
    })),
  };
}

export function toConciseRows(
  report: MacrofactorReport,
  options?: { dateFormat?: ConciseDateFormat }
): MacrofactorConciseRow[] {
  const dateFormat = options?.dateFormat ?? 'iso';
  const rows = report.foods.map(food => {
    const parts = getDateTimeParts(food.latestConsumedAt, dateFormat);
    return {
      timestamp: Date.parse(food.latestConsumedAt),
      row: {
        date: parts.date,
        time: parts.time.split(':').slice(0, 2).join(':'),
        name: food.title,
        serving: food.serving,
        servingGrams: food.servingGrams,
        calories: food.nutrition.caloriesKcal,
        protein: food.nutrition.proteinG,
        carbs: food.nutrition.carbsG,
        fat: food.nutrition.fatG,
        fiber: food.nutrition.fiberG,
      } satisfies MacrofactorConciseRow,
    };
  });
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows.map(row => row.row);
}

export function renderCsv(rows: MacrofactorConciseRow[]): string {
  return renderCsvRecords(
    rows.map(row => ({
      ...row,
    })) as Record<string, CsvValue>[],
    CSV_COLUMNS
  );
}

export function renderFullCsv(report: MacrofactorReport, options?: { full?: boolean }): string {
  const full = options?.full ?? false;
  const sections = [
    {
      name: 'daily_overview',
      csv: renderCsvRecords(toDailyOverviewCsvRows(report), DAILY_OVERVIEW_COLUMNS),
    },
    {
      name: 'detailed_foods_day',
      csv: full
        ? (() => {
            const rows = toFullRows(report, { dateFormat: 'csv' });
            return renderCsvRecords(rows.rows, rows.columns);
          })()
        : renderCsv(toConciseRows(report, { dateFormat: 'csv' })),
    },
    {
      name: 'recipe_meal_breakdown',
      csv: renderCsvRecords(toRecipeBreakdownCsvRows(report), RECIPE_BREAKDOWN_COLUMNS),
    },
  ];

  return `${sections.map(section => `\n==== ${section.name} ===\n${section.csv}`).join('')}`;
}

export function toFullRows(
  report: MacrofactorReport,
  options?: { dateFormat?: ConciseDateFormat }
): { columns: string[]; rows: Record<string, CsvValue>[] } {
  const dateFormat = options?.dateFormat ?? 'iso';
  const prepared = report.foods.map(food => {
    const parts = getDateTimeParts(food.latestConsumedAt, dateFormat);
    return {
      timestamp: Date.parse(food.latestConsumedAt),
      base: {
        date: parts.date,
        time: parts.time.split(':').slice(0, 2).join(':'),
        name: food.title,
        serving: food.serving,
        servingGrams: food.servingGrams,
      } satisfies Record<(typeof FULL_BASE_COLUMNS)[number], CsvValue>,
      nutrients: flattenNamedNutrients(food.nutrition),
    };
  });
  const nutrientColumns = collectNutrientColumns(prepared.map(row => row.nutrients));
  const columns = [...FULL_BASE_COLUMNS, ...nutrientColumns];
  prepared.sort((a, b) => b.timestamp - a.timestamp);
  return {
    columns,
    rows: prepared.map(row => {
      const record: Record<string, CsvValue> = { ...row.base };
      for (const column of nutrientColumns) {
        record[column] = row.nutrients[column] ?? null;
      }
      return record;
    }),
  };
}

export function resolveWindow(options: {
  days: number;
  start?: string;
  end?: string;
  nowUnixSeconds?: number;
}): ResolvedWindow {
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive number.');
  }

  const nowUnixSeconds = options.nowUnixSeconds ?? Date.now() / 1000;
  const endUnixSeconds = options.end ? parseDateArg(options.end, 'end') : nowUnixSeconds;
  const startUnixSeconds = options.start
    ? parseDateArg(options.start, 'start')
    : endUnixSeconds - options.days * SECONDS_PER_DAY;

  if (startUnixSeconds > endUnixSeconds) {
    throw new Error('Start date must be before end date.');
  }

  return { startUnixSeconds, endUnixSeconds };
}

export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

async function runCli(): Promise<void> {
  try {
    const args = await yargs(hideBin(process.argv))
      .scriptName('macrofactor')
      .strict()
      .option('days', {
        alias: ['d'],
        type: 'number',
        default: 7,
        describe: 'Lookback window in days when --start is not set',
      })
      .option('start', {
        type: 'string',
        describe: 'Start date/time in ISO format (e.g. 2026-02-01 or 2026-02-01T00:00:00Z)',
      })
      .option('end', {
        type: 'string',
        describe: 'End date/time in ISO format',
      })
      .option('limit', {
        alias: ['l'],
        type: 'number',
        describe: 'Maximum number of foods to return',
      })
      .option('format', {
        alias: ['f'],
        type: 'string',
        choices: OUTPUT_FORMATS,
        default: 'table',
        describe: 'Output format',
      })
      .option('output', {
        alias: ['o'],
        type: 'string',
        describe: 'Write output to this file path',
      })
      .option('pretty', {
        type: 'boolean',
        default: true,
        describe: 'Pretty-print JSON output',
      })
      .option('full', {
        type: 'boolean',
        default: false,
        describe: 'Include all nutrients in CSV/table output',
      })
      .help()
      .parseAsync();

    if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
      throw new Error('--limit must be a positive number.');
    }

    const credentials = parseMacrofactorCredentials(env.MACROFACTOR_CREDENTIALS);
    const client = await MacroFactorApiClient.login(credentials.email, credentials.password);
    const window = resolveWindow({
      days: args.days,
      start: args.start,
      end: args.end,
    });
    const dayDocuments = await fetchFoodLogDays(client, window);
    const [customFoodDetails, programTargets, scaleWeights] = await Promise.all([
      fetchCustomFoodDetails(client, dayDocuments),
      fetchProgramTargets(client, window),
      fetchScaleWeights(client, window),
    ]);
    const report = buildMacrofactorApiReport({
      sourcePath: SOURCE_PATH,
      dayDocuments,
      customFoodDetails,
      programTargets,
      scaleWeights,
      days: args.days,
      start: args.start,
      end: args.end,
      limit: args.limit,
    });

    renderOutput({
      report,
      format: parseOutputFormat(args.format),
      outputPath: args.output,
      pretty: args.pretty,
      full: args.full,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

export async function fetchFoodLogDays(client: MacroFactorApiClient, window: ResolvedWindow): Promise<ApiFoodLogDay[]> {
  const dateKeys = listFetchDateKeys(window);
  const days: ApiFoodLogDay[] = [];
  for (let index = 0; index < dateKeys.length; index += FOOD_DOC_BATCH_SIZE) {
    const batch = dateKeys.slice(index, index + FOOD_DOC_BATCH_SIZE);
    const batchDays = await Promise.all(
      batch.map(async date => ({
        date,
        document: await client.getFoodLogDocument(date),
      }))
    );
    days.push(...batchDays);
  }
  return days;
}

export async function fetchProgramTargets(client: MacroFactorApiClient, window: ResolvedWindow): Promise<ProgramTarget[]> {
  const years = listProgramYears(window);
  const documents = await Promise.all(
    years.map(async year => ({
      year,
      document: await client.getProgramDocument(year),
    }))
  );
  const targets: ProgramTarget[] = [];

  for (const { year, document } of documents) {
    if (!document) {
      continue;
    }
    for (const [monthDay, rawValue] of Object.entries(document)) {
      const raw = asRecord(rawValue);
      if (!raw || !/^\d{4}$/.test(monthDay)) {
        continue;
      }
      targets.push({
        effectiveDate: `${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2)}`,
        calories: parseNullableNumberArray(raw.calories),
        protein: parseNullableNumberArray(raw.protein),
        carbs: parseNullableNumberArray(raw.carbs),
        fat: parseNullableNumberArray(raw.fat),
      });
    }
  }

  targets.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return targets;
}

async function fetchScaleWeights(client: MacroFactorApiClient, window: ResolvedWindow): Promise<Record<string, number>> {
  const years = listWindowYears(window);
  const documents = await Promise.all(
    years.map(async year => ({
      year,
      document: await client.getScaleDocument(year),
    }))
  );
  const weights: Record<string, number> = {};

  for (const { year, document } of documents) {
    if (!document) {
      continue;
    }
    for (const [monthDay, rawValue] of Object.entries(document)) {
      const raw = asRecord(rawValue);
      const weight = raw ? parseNumberLike(raw.w) : null;
      if (!raw || !/^\d{4}$/.test(monthDay) || weight == null) {
        continue;
      }
      weights[`${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2)}`] = weight;
    }
  }

  return weights;
}

export function buildMacrofactorApiReport(options: BuildApiReportOptions): MacrofactorReport {
  const window = resolveWindow({
    days: options.days,
    start: options.start,
    end: options.end,
    nowUnixSeconds: options.nowUnixSeconds,
  });
  const startMs = window.startUnixSeconds * 1000;
  const endMs = window.endUnixSeconds * 1000;
  const entries = options.dayDocuments
    .flatMap(day => parseFoodLogEntries(day, options.customFoodDetails ?? {}))
    .filter(entry => entry.timestampMs >= startMs && entry.timestampMs <= endMs);
  const groups = new Map<
    string,
    {
      firstTimestampMs: number;
      latestTimestampMs: number;
      representative: ParsedFoodLogEntry;
    }
  >();

  for (const entry of entries) {
    const existing = groups.get(entry.groupKey);
    if (!existing) {
      groups.set(entry.groupKey, {
        firstTimestampMs: entry.timestampMs,
        latestTimestampMs: entry.timestampMs,
        representative: entry,
      });
      continue;
    }
    existing.firstTimestampMs = Math.min(existing.firstTimestampMs, entry.timestampMs);
    if (entry.timestampMs >= existing.latestTimestampMs) {
      existing.latestTimestampMs = entry.timestampMs;
      existing.representative = entry;
    }
  }

  const rows = Array.from(groups.values())
    .map(group => {
      const representative = group.representative;
      return {
        itemId: representative.itemId,
        title: representative.title,
        brandName: representative.brandName,
        source: representative.source,
        isCustom: representative.isCustom,
        kind: representative.kind,
        recipeId: representative.recipeId,
        firstConsumedAt: new Date(group.firstTimestampMs).toISOString(),
        latestConsumedAt: new Date(group.latestTimestampMs).toISOString(),
        serving: representative.serving,
        servingGrams: representative.servingGrams,
        nutrition: representative.nutrition,
      } satisfies MacrofactorFoodRecord;
    })
    .sort((a, b) => Date.parse(b.latestConsumedAt) - Date.parse(a.latestConsumedAt));

  const limitedRows =
    options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? rows.slice(0, Math.floor(options.limit))
      : rows;

  return {
    generatedAt: new Date().toISOString(),
    sourcePath: options.sourcePath,
    window: {
      start: toIso(window.startUnixSeconds),
      end: toIso(window.endUnixSeconds),
    },
    matchedFoods: rows.length,
    returnedFoods: limitedRows.length,
    dailyOverview: buildDailyOverview(window, entries, options.programTargets ?? [], options.scaleWeights ?? {}),
    foods: limitedRows,
    recipeBreakdown: buildRecipeBreakdown(entries, options.customFoodDetails ?? {}),
  };
}

export function parseMacrofactorCredentials(value: string | undefined): { email: string; password: string } {
  const raw = value?.trim();
  if (!raw) {
    throw new Error('MACROFACTOR_CREDENTIALS is not set. Expected <email>:<password>.');
  }

  const separatorIndex = raw.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error('MACROFACTOR_CREDENTIALS must use the format <email>:<password>.');
  }

  const email = raw.slice(0, separatorIndex).trim();
  const password = raw.slice(separatorIndex + 1);
  if (!email || !password) {
    throw new Error('MACROFACTOR_CREDENTIALS must include both a non-empty email and password.');
  }

  return { email, password };
}

export function parseFoodLogTimestamp(entryId: string, fallbackDate?: string, fallbackHour?: unknown, fallbackMinute?: unknown): number | null {
  const asNumber = Number(entryId);
  if (Number.isSafeInteger(asNumber) && asNumber > 0) {
    if (asNumber >= 1_000_000_000_000_000) {
      return Math.trunc(asNumber / 1000);
    }
    if (asNumber >= 1_000_000_000_000) {
      return Math.trunc(asNumber);
    }
  }

  if (!fallbackDate) {
    return null;
  }
  const [year, month, day] = fallbackDate.split('-').map(part => Number(part));
  if (![year, month, day].every(Number.isFinite)) {
    return null;
  }
  const hour = parseNumberLike(fallbackHour) ?? 0;
  const minute = parseNumberLike(fallbackMinute) ?? 0;
  const fallbackMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return Number.isFinite(fallbackMs) ? fallbackMs : null;
}

function parseFoodLogEntries(day: ApiFoodLogDay, customFoodDetails: Record<string, CustomFoodDetails>): ParsedFoodLogEntry[] {
  if (!day.document) {
    return [];
  }

  const entries: ParsedFoodLogEntry[] = [];
  for (const [entryId, rawValue] of Object.entries(day.document)) {
    if (entryId.startsWith('_')) {
      continue;
    }
    const raw = asRecord(rawValue);
    if (!raw) {
      continue;
    }
    if (raw.d === true) {
      continue;
    }

    const timestampMs = parseFoodLogTimestamp(entryId, day.date, raw.h, raw.mi);
    if (timestampMs == null) {
      continue;
    }

    const itemId = parseString(raw.id) ?? entryId;
    const title = parseString(raw.t) ?? parseString(raw.b) ?? '(untitled)';
    const source = parseString(raw.k);
    const customInfo = customFoodDetails[itemId] ?? { kind: 'food', recipeId: null, ingredients: [] };

    entries.push({
      groupKey: itemId,
      itemId,
      title,
      brandName: parseOptionalString(raw.b),
      source,
      isCustom: source != null && source !== 't',
      kind: customInfo.kind,
      recipeId: customInfo.recipeId,
      timestampMs,
      consumedDate: formatDateKey(timestampMs),
      serving: buildServingString(parseNumberLike(raw.y), parseOptionalString(raw.s)),
      servingGrams: parseNumberLike(raw.g),
      nutrition: buildNutrition(raw),
    });
  }

  return entries;
}

function buildNutrition(raw: Record<string, unknown>): MacrofactorFoodRecord['nutrition'] {
  const multiplier = computeMultiplier(raw);
  const calories = scaleValue(raw.c, multiplier);
  const protein = scaleValue(raw.p, multiplier);
  const carbs = scaleValue(raw.e, multiplier);
  const fat = scaleValue(raw.f, multiplier);
  const nutrientCodes = parseNumericNutrientCodes(raw, multiplier);
  const fiber = maybeNumber(nutrientCodes['291']);
  const sugar = maybeNumber(nutrientCodes['269']);
  const alcohol = maybeNumber(nutrientCodes['221']);
  const byCode: Record<string, number> = { ...nutrientCodes };

  setByCodeValue(byCode, 'k', calories);
  setByCodeValue(byCode, 'p', protein);
  setByCodeValue(byCode, 'c', carbs);
  setByCodeValue(byCode, 'f', fat);
  setByCodeValue(byCode, 'e', fiber);
  setByCodeValue(byCode, 's', sugar);
  setByCodeValue(byCode, 'a', alcohol);

  const named: Record<string, number> = {};
  for (const [code, value] of Object.entries(byCode)) {
    const name = CODE_NAME_MAP[code];
    if (name) {
      named[name] = value;
    }
  }

  return {
    caloriesKcal: calories,
    proteinG: protein,
    carbsG: carbs,
    fatG: fat,
    fiberG: fiber,
    sugarG: sugar,
    netCarbsG: null,
    alcoholG: alcohol,
    byCode,
    named,
  };
}

function buildServingString(quantity: number | null, unit: string | null): string {
  const quantityPart = quantity == null ? '?' : formatServingNumber(quantity);
  const unitPart = unit ?? 'serving';
  return `${quantityPart} ${unitPart}`;
}

function formatServingNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Number(value.toFixed(3)).toString();
}

function parseNumericNutrientCodes(raw: Record<string, unknown>, multiplier: number): Record<string, number> {
  const nutrients: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    const parsed = parseNumberLike(value);
    if (parsed == null) {
      continue;
    }
    nutrients[key] = parsed * multiplier;
  }
  return nutrients;
}

function computeMultiplier(raw: Record<string, unknown>): number {
  const servingGrams = parseNumberLike(raw.g);
  const userQuantity = parseNumberLike(raw.y);
  const unitWeight = parseNumberLike(raw.w);
  if (servingGrams != null && userQuantity != null && unitWeight != null && servingGrams > 0) {
    return (userQuantity * unitWeight) / servingGrams;
  }
  return 1;
}

function scaleValue(value: unknown, multiplier: number): number | null {
  const parsed = parseNumberLike(value);
  if (parsed == null) {
    return null;
  }
  return parsed * multiplier;
}

function setByCodeValue(target: Record<string, number>, code: string, value: number | null): void {
  if (value != null) {
    target[code] = value;
  }
}

function maybeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseOptionalString(value: unknown): string | null {
  const parsed = parseString(value);
  return parsed === '' ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function listFetchDateKeys(window: ResolvedWindow): string[] {
  const startDate = new Date((window.startUnixSeconds - 24 * 60 * 60) * 1000);
  const endDate = new Date((window.endUnixSeconds + 24 * 60 * 60) * 1000);
  const current = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  const dateKeys: string[] = [];

  for (let timestamp = current; timestamp <= end; timestamp += 24 * 60 * 60 * 1000) {
    dateKeys.push(formatDateKey(timestamp));
  }
  return dateKeys;
}

function formatDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function buildDailyOverview(
  window: ResolvedWindow,
  entries: ParsedFoodLogEntry[],
  programTargets: ProgramTarget[],
  scaleWeights: Record<string, number>
): MacrofactorDailyOverviewRecord[] {
  const totals = new Map(
    listWindowDateKeys(window).map(date => [
      date,
      {
        calories: 0,
        carbs: 0,
        protein: 0,
        fat: 0,
        fiber: 0,
        foods_logged: 0,
      },
    ])
  );

  for (const entry of entries) {
    const day = totals.get(entry.consumedDate);
    if (!day) {
      continue;
    }
    day.calories += entry.nutrition.caloriesKcal ?? 0;
    day.carbs += entry.nutrition.carbsG ?? 0;
    day.protein += entry.nutrition.proteinG ?? 0;
    day.fat += entry.nutrition.fatG ?? 0;
    day.fiber += entry.nutrition.fiberG ?? 0;
    day.foods_logged += 1;
  }

  return Array.from(totals.entries())
    .map(([date, totalsForDate]) => {
      const goals = findProgramGoalsForDate(date, programTargets);
      return {
        date,
        weightKg: scaleWeights[date] ?? null,
        calories: totalsForDate.calories,
        carbs: totalsForDate.carbs,
        protein: totalsForDate.protein,
        fat: totalsForDate.fat,
        fiber: totalsForDate.fiber,
        goal_calories: goals.goal_calories,
        goal_protein: goals.goal_protein,
        goal_carbs: goals.goal_carbs,
        goal_fat: goals.goal_fat,
        foods_logged: totalsForDate.foods_logged,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function buildRecipeBreakdown(
  entries: ParsedFoodLogEntry[],
  customFoodDetails: Record<string, CustomFoodDetails>
): MacrofactorRecipeBreakdownRecord[] {
  const groups = new Map<
    string,
    {
      latestTimestampMs: number;
      representative: ParsedFoodLogEntry;
      consumedOn: Set<string>;
    }
  >();

  for (const entry of entries) {
    if (entry.kind !== 'recipe' || !entry.recipeId) {
      continue;
    }
    const existing = groups.get(entry.recipeId);
    if (!existing) {
      groups.set(entry.recipeId, {
        latestTimestampMs: entry.timestampMs,
        representative: entry,
        consumedOn: new Set([entry.consumedDate]),
      });
      continue;
    }
    existing.consumedOn.add(entry.consumedDate);
    if (entry.timestampMs >= existing.latestTimestampMs) {
      existing.latestTimestampMs = entry.timestampMs;
      existing.representative = entry;
    }
  }

  return Array.from(groups.entries())
    .map(([recipeId, group]) => ({
      recipeId,
      name: group.representative.title,
      ingredients: customFoodDetails[recipeId]?.ingredients ?? [],
      nutrition: group.representative.nutrition,
      consumed_on: Array.from(group.consumedOn).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      const latestA = a.consumed_on.at(-1) ?? '';
      const latestB = b.consumed_on.at(-1) ?? '';
      return latestB.localeCompare(latestA) || a.name.localeCompare(b.name);
    });
}

async function fetchCustomFoodDetails(
  client: MacroFactorApiClient,
  dayDocuments: ApiFoodLogDay[]
): Promise<Record<string, CustomFoodDetails>> {
  const ids = collectCustomFoodIds(dayDocuments);
  const info: Record<string, CustomFoodDetails> = {};
  for (const id of ids) {
    const document = await client.getCustomFoodDocument(id);
    if (!document) {
      continue;
    }
    info[id] = parseCustomFoodDetails(id, document);
  }
  return info;
}

function collectCustomFoodIds(dayDocuments: ApiFoodLogDay[]): string[] {
  const ids = new Set<string>();
  for (const day of dayDocuments) {
    if (!day.document) {
      continue;
    }
    for (const rawValue of Object.values(day.document)) {
      const entry = asRecord(rawValue);
      if (!entry || entry.d === true) {
        continue;
      }
      const source = parseString(entry.k);
      const id = parseString(entry.id);
      if (!id || !source || source === 't') {
        continue;
      }
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function parseCustomFoodDetails(id: string, document: Record<string, unknown>): CustomFoodDetails {
  const ingredients = document.r;
  const brandName = parseString(document.b);
  const isRecipe =
    (Array.isArray(ingredients) && ingredients.length > 0) ||
    brandName === 'Custom Recipe';
  return {
    kind: isRecipe ? 'recipe' : 'food',
    recipeId: isRecipe ? id : null,
    ingredients: isRecipe ? parseRecipeIngredients(ingredients) : [],
  };
}

function parseRecipeIngredients(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(rawIngredient => {
      const ingredient = asRecord(rawIngredient);
      if (!ingredient) {
        return null;
      }
      const name = parseString(ingredient.t) ?? parseString(ingredient.b);
      if (!name) {
        return null;
      }
      const unit = parseOptionalString(ingredient.u) ?? parseOptionalString(ingredient.s);
      return `[${buildServingString(parseNumberLike(ingredient.y), unit)}] ${name}`;
    })
    .filter((ingredient): ingredient is string => ingredient != null);
}

function findProgramGoalsForDate(
  date: string,
  programTargets: ProgramTarget[]
): Pick<MacrofactorDailyOverviewRecord, 'goal_calories' | 'goal_protein' | 'goal_carbs' | 'goal_fat'> {
  let activeTarget: ProgramTarget | null = null;
  for (const target of programTargets) {
    if (target.effectiveDate > date) {
      break;
    }
    activeTarget = target;
  }
  if (!activeTarget) {
    return {
      goal_calories: null,
      goal_protein: null,
      goal_carbs: null,
      goal_fat: null,
    };
  }
  return {
    goal_calories: pickProgramValue(activeTarget.calories, activeTarget.effectiveDate, date),
    goal_protein: pickProgramValue(activeTarget.protein, activeTarget.effectiveDate, date),
    goal_carbs: pickProgramValue(activeTarget.carbs, activeTarget.effectiveDate, date),
    goal_fat: pickProgramValue(activeTarget.fat, activeTarget.effectiveDate, date),
  };
}

function pickProgramValue(
  values: Array<number | null>,
  effectiveDate: string,
  date: string
): number | null {
  if (values.length === 0) {
    return null;
  }
  const effectiveMs = Date.parse(`${effectiveDate}T00:00:00.000Z`);
  const dateMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(dateMs) || dateMs < effectiveMs) {
    return null;
  }
  const dayOffset = Math.floor((dateMs - effectiveMs) / (SECONDS_PER_DAY * 1000));
  const index = dayOffset % values.length;
  const value = values[index] ?? values[0];
  return value == null ? null : value;
}

function parseNullableNumberArray(value: unknown): Array<number | null> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(entry => parseNumberLike(entry));
}

function listProgramYears(window: ResolvedWindow): number[] {
  const startYear = new Date(window.startUnixSeconds * 1000).getUTCFullYear() - 1;
  const endYear = new Date(window.endUnixSeconds * 1000).getUTCFullYear();
  return listYearsInRange(startYear, endYear);
}

function listWindowYears(window: ResolvedWindow): number[] {
  const startYear = new Date(window.startUnixSeconds * 1000).getUTCFullYear();
  const endYear = new Date(window.endUnixSeconds * 1000).getUTCFullYear();
  return listYearsInRange(startYear, endYear);
}

function listYearsInRange(startYear: number, endYear: number): number[] {
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }
  return years;
}

function listWindowDateKeys(window: ResolvedWindow): string[] {
  const start = Date.UTC(
    new Date(window.startUnixSeconds * 1000).getUTCFullYear(),
    new Date(window.startUnixSeconds * 1000).getUTCMonth(),
    new Date(window.startUnixSeconds * 1000).getUTCDate()
  );
  const end = Date.UTC(
    new Date(window.endUnixSeconds * 1000).getUTCFullYear(),
    new Date(window.endUnixSeconds * 1000).getUTCMonth(),
    new Date(window.endUnixSeconds * 1000).getUTCDate()
  );
  const dates: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += SECONDS_PER_DAY * 1000) {
    dates.push(formatDateKey(timestamp));
  }
  return dates;
}

function renderTable(report: MacrofactorReport, options: { full: boolean }): void {
  process.stdout.write('Daily Overview\n');
  printTable(report.dailyOverview);
  process.stdout.write('\nDetailed Foods / Day\n');
  printTable(options.full ? toFullRows(report, { dateFormat: 'table' }).rows : toConciseRows(report, { dateFormat: 'table' }));
  process.stdout.write('\nRecipe / Meal Breakdown\n');
  printTable(
    report.recipeBreakdown.map(recipe => ({
      name: recipe.name,
      ingredients: recipe.ingredients.join('\n'),
      nutrition: formatNutritionLines(recipe.nutrition).join('\n'),
      consumed_on: recipe.consumed_on.join(', '),
    }))
  );
}

function toDailyOverviewCsvRows(report: MacrofactorReport): Record<string, CsvValue>[] {
  return report.dailyOverview.map(row => ({
    date: row.date,
    weightKg: row.weightKg,
    calories: row.calories,
    carbs: row.carbs,
    protein: row.protein,
    fat: row.fat,
    fiber: row.fiber,
    goal_calories: row.goal_calories,
    goal_protein: row.goal_protein,
    goal_carbs: row.goal_carbs,
    goal_fat: row.goal_fat,
    foods_logged: row.foods_logged,
  }));
}

function toRecipeBreakdownCsvRows(report: MacrofactorReport): Record<string, CsvValue>[] {
  return report.recipeBreakdown.map(recipe => ({
    name: recipe.name,
    ingredients: recipe.ingredients.join('\n'),
    nutrition: formatNutritionLines(recipe.nutrition).join('\n'),
    consumed_on: recipe.consumed_on.join(', '),
  }));
}

function printTable(rows: object[]): void {
  renderTableRecords(rows);
}

function parseDateArg(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return timestamp / 1000;
}

function getDateTimeParts(value: string, dateFormat: ConciseDateFormat): { date: string; time: string } {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return { date: '', time: '' };
  }
  const date = formatDate(timestamp, dateFormat);
  const iso = new Date(timestamp).toISOString();
  return {
    date,
    time: iso.slice(11, 19),
  };
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function formatDate(timestamp: number, format: ConciseDateFormat): string {
  const d = new Date(timestamp);
  if (format === 'iso') {
    return d.toISOString().slice(0, 10);
  }
  if (format === 'csv') {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getUTCFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }
  const weekday = WEEKDAYS_SHORT[d.getUTCDay()] ?? '';
  const month = MONTHS_LONG[d.getUTCMonth()] ?? '';
  const day = formatOrdinal(d.getUTCDate());
  return `${weekday} ${month} ${day}`.trim();
}

function formatOrdinal(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  const abs = Math.abs(Math.trunc(value));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${abs}th`;
  }
  const mod10 = abs % 10;
  const suffix = mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
  return `${abs}${suffix}`;
}

function flattenNamedNutrients(nutrition: MacrofactorFoodRecord['nutrition']): Record<string, number> {
  const flattened: Record<string, number> = {};

  setNamedNutrient(flattened, 'calories_kcal', nutrition.caloriesKcal);
  setNamedNutrient(flattened, 'protein_g', nutrition.proteinG);
  setNamedNutrient(flattened, 'carbs_g', nutrition.carbsG);
  setNamedNutrient(flattened, 'fat_g', nutrition.fatG);
  setNamedNutrient(flattened, 'fiber_g', nutrition.fiberG);
  setNamedNutrient(flattened, 'sugars_g', nutrition.sugarG);
  setNamedNutrient(flattened, 'net_carbs_g', nutrition.netCarbsG);
  setNamedNutrient(flattened, 'alcohol_g', nutrition.alcoholG);

  for (const [name, value] of Object.entries(nutrition.named)) {
    setNamedNutrient(flattened, name, value);
  }

  for (const [code, value] of Object.entries(nutrition.byCode)) {
    const name = mapNutrientCodeToName(code);
    if (!name) {
      continue;
    }
    setNamedNutrient(flattened, name, value);
  }

  return flattened;
}

function formatNutritionLines(nutrition: MacrofactorFoodRecord['nutrition']): string[] {
  return Object.entries(flattenNamedNutrients(nutrition)).map(([name, value]) => {
    const { label, unit } = splitNutrientNameAndUnit(name);
    const displayValue = formatDisplayNumber(value);
    return `${label}: ${displayValue} ${unit}`.trimEnd();
  });
}

function setNamedNutrient(target: Record<string, number>, name: string, value: number | null | undefined): void {
  if (target[name] != null || !Number.isFinite(value)) {
    return;
  }
  target[name] = value as number;
}

function splitNutrientNameAndUnit(name: string): { label: string; unit: string } {
  const match = name.match(/^(.*)_(kcal|mg|ug|g|ug_rae)$/);
  if (!match) {
    return { label: name, unit: '' };
  }
  return {
    label: match[1],
    unit: match[2],
  };
}

function mapNutrientCodeToName(code: string): string | null {
  if (NUTRIENT_CODE_NAME_MAP[code]) {
    return NUTRIENT_CODE_NAME_MAP[code];
  }
  if (/^\d+$/.test(code)) {
    return `nutrient_${code}`;
  }
  return null;
}

function collectNutrientColumns(nutrientsList: Record<string, number>[]): string[] {
  const columns = new Set<string>();
  for (const nutrients of nutrientsList) {
    for (const name of Object.keys(nutrients)) {
      columns.add(name);
    }
  }
  const preferredOrder = new Map<string, number>(PREFERRED_NUTRIENT_ORDER.map((name, index) => [name, index]));
  return Array.from(columns).sort((a, b) => {
    const aIndex = preferredOrder.get(a);
    const bIndex = preferredOrder.get(b);
    if (aIndex != null && bIndex != null) {
      return aIndex - bIndex;
    }
    if (aIndex != null) {
      return -1;
    }
    if (bIndex != null) {
      return 1;
    }
    return a.localeCompare(b);
  });
}

export function parseFirestoreValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const typedValue = value as Record<string, unknown>;
  if ('stringValue' in typedValue) {
    return typedValue.stringValue ?? null;
  }
  if ('integerValue' in typedValue) {
    return parseNumberLike(typedValue.integerValue) ?? typedValue.integerValue ?? null;
  }
  if ('doubleValue' in typedValue) {
    return parseNumberLike(typedValue.doubleValue) ?? typedValue.doubleValue ?? null;
  }
  if ('booleanValue' in typedValue) {
    return Boolean(typedValue.booleanValue);
  }
  if ('nullValue' in typedValue) {
    return null;
  }
  if ('timestampValue' in typedValue) {
    return typedValue.timestampValue ?? null;
  }
  if ('referenceValue' in typedValue) {
    return typedValue.referenceValue ?? null;
  }
  if ('geoPointValue' in typedValue) {
    return typedValue.geoPointValue ?? null;
  }
  if ('bytesValue' in typedValue) {
    return typedValue.bytesValue ?? null;
  }
  if ('mapValue' in typedValue) {
    const mapValue = typedValue.mapValue;
    if (mapValue && typeof mapValue === 'object' && !Array.isArray(mapValue)) {
      return parseFirestoreFields((mapValue as { fields?: unknown }).fields);
    }
    return {};
  }
  if ('arrayValue' in typedValue) {
    const arrayValue = typedValue.arrayValue;
    if (!arrayValue || typeof arrayValue !== 'object' || Array.isArray(arrayValue)) {
      return [];
    }
    const values = (arrayValue as { values?: unknown }).values;
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map(parseFirestoreValue);
  }
  return typedValue;
}

export function parseFirestoreFields(fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = parseFirestoreValue(value);
  }
  return result;
}

class MacroFactorApiClient {
  private constructor(private readonly session: FirebaseSession) {}

  static async login(email: string, password: string): Promise<MacroFactorApiClient> {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ios-Bundle-Identifier': IOS_BUNDLE_ID,
        },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`MacroFactor sign-in failed: ${await formatError(response)}`);
    }

    const data = (await response.json()) as FirebaseSignInResponse;
    if (!data.idToken || !data.refreshToken || !data.expiresIn || !data.localId) {
      throw new Error('MacroFactor sign-in response was missing required auth fields.');
    }

    return new MacroFactorApiClient({
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAtMs: Date.now() + Number(data.expiresIn) * 1000,
      userId: data.localId,
    });
  }

  async getFoodLogDocument(date: string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`food/${date}`, `MacroFactor food log request failed for ${date}`);
  }

  async getCustomFoodDocument(id: string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`customFoods/${id}`, `MacroFactor custom food request failed for ${id}`);
  }

  async getProgramDocument(year: number | string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`program/${year}`, `MacroFactor program request failed for ${year}`);
  }

  async getScaleDocument(year: number | string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`scale/${year}`, `MacroFactor scale request failed for ${year}`);
  }

  private async getUserDocument(pathSuffix: string, errorLabel: string): Promise<Record<string, unknown> | null> {
    const token = await this.getIdToken();
    const response = await fetch(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/${pathSuffix}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`${errorLabel}: ${await formatError(response)}`);
    }

    const document = (await response.json()) as FirestoreDocumentResponse;
    return parseFirestoreFields(document.fields);
  }

  private async getIdToken(): Promise<string> {
    if (this.session.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.session.idToken;
    }

    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Ios-Bundle-Identifier': IOS_BUNDLE_ID,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.session.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`MacroFactor token refresh failed: ${await formatError(response)}`);
    }

    const data = (await response.json()) as FirebaseRefreshResponse;
    if (!data.id_token || !data.refresh_token || !data.expires_in) {
      throw new Error('MacroFactor token refresh response was missing required auth fields.');
    }

    this.session.idToken = data.id_token;
    this.session.refreshToken = data.refresh_token;
    this.session.expiresAtMs = Date.now() + Number(data.expires_in) * 1000;
    return this.session.idToken;
  }
}

async function formatError(response: Response): Promise<string> {
  const body = await response.text();
  const snippet = body.trim().slice(0, 500);
  return `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ''}`;
}
