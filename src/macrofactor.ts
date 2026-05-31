#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClassicLevel } from 'classic-level';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  OUTPUT_FORMATS,
  formatDisplayNumber,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputFormat,
} from './utils/output';

const SOURCE_PATH = 'cache://macrofactor/firestore';
const MACROFACTOR_APP_BUNDLE_ID = 'com.sbs.diet';
const MACROFACTOR_APP_NAME = 'MacroFactor';
const FIRESTORE_CACHE_RELATIVE_DIR = path.join(
  'Data',
  'Library',
  'Application Support',
  'firestore',
  '__FIRAPP_DEFAULT',
  'sbs-diet-app',
  'main'
);
const CACHE_SYNC_STATE_PATH = path.join(os.homedir(), '.cache', 'scripts', 'macrofactor-cache-sync.json');
const APP_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CACHE_REFRESH_POLL_MS = 1_000;
const APP_LAUNCH_TIMEOUT_MS = 30_000;
const APP_UI_SETTLE_MS = 900;
const APP_DAY_NAVIGATION_SETTLE_MS = 650;
const FOOD_DOC_BATCH_SIZE = 10;
const SECONDS_PER_DAY = 24 * 60 * 60;
const APP_MODES = ['auto', 'open', 'none'] as const;
type MacroFactorAppMode = (typeof APP_MODES)[number];
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
  'bodyFatPct',
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

interface BuildApiReportOptions {
  sourcePath: string;
  dayDocuments: ApiFoodLogDay[];
  customFoodDetails?: Record<string, CustomFoodDetails>;
  programTargets?: ProgramTarget[];
  scaleMetrics?: Record<string, ScaleMetrics>;
  microNutrition?: Record<string, DailyNutritionTotals>;
  days: number;
  start?: string;
  end?: string;
  limit?: number;
  nowUnixSeconds?: number;
}

interface ApiFoodLogDay {
  date: string;
  document: Record<string, unknown> | null;
}

interface ParsedFoodLogEntry {
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

interface ScaleMetrics {
  weightKg: number | null;
  bodyFatPct: number | null;
}

interface DailyNutritionTotals {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  fiber: number;
}

interface CacheSyncState {
  refreshedDate?: string;
  refreshedAt?: string;
  appOpenedAt?: string;
  warmedAt?: string;
  warmedStartDate?: string;
  warmedEndDate?: string;
  cacheMtimeMs?: number;
}

interface MacrofactorReport {
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

interface MacrofactorFoodRecord {
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

interface MacrofactorDailyOverviewRecord {
  date: string;
  weightKg: number | null;
  bodyFatPct: number | null;
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

interface MacrofactorRecipeBreakdownRecord {
  recipeId: string;
  name: string;
  ingredients: string[];
  nutrition: MacrofactorFoodRecord['nutrition'];
  consumed_on: string[];
}

interface MacrofactorConciseRow {
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

interface ResolvedWindow {
  startUnixSeconds: number;
  endUnixSeconds: number;
}

type ConciseDateFormat = 'iso' | 'table' | 'csv';
const DAILY_OVERVIEW_VALUE_FORMATTERS = {
  weightKg: (value: unknown) => value,
  bodyFatPct: (value: unknown) => value,
} as const;

if (import.meta.main) {
  void runCli();
}

function renderOutput(options: {
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
      return `${JSON.stringify(serializeReport(options.report), null, options.pretty ? 2 : 0)}\n`;
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

function serializeReport(report: MacrofactorReport): Record<string, unknown> {
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

function toConciseRows(
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

function renderCsv(rows: MacrofactorConciseRow[]): string {
  return renderCsvRecords(
    rows.map(row => ({
      ...row,
    })) as Record<string, CsvValue>[],
    CSV_COLUMNS
  );
}

function renderFullCsv(report: MacrofactorReport, options?: { full?: boolean }): string {
  const full = options?.full ?? false;
  const sections = [
    {
      name: 'daily_overview',
      csv: renderCsvRecords(toDailyOverviewCsvRows(report), DAILY_OVERVIEW_COLUMNS, {
        valueFormatters: DAILY_OVERVIEW_VALUE_FORMATTERS,
      }),
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

function toFullRows(
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

function resolveWindow(options: {
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

function toIso(unixSeconds: number): string {
  return formatLocalIso(unixSeconds * 1000);
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
      .option('app', {
        type: 'string',
        choices: APP_MODES,
        default: 'auto',
        describe: 'MacroFactor app warm mode: auto opens when stale or missing docs, open always opens, none never opens',
      })
      .version(false)
      .help()
      .parseAsync();

    if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
      throw new Error('--limit must be a positive number.');
    }

    const window = resolveWindow({
      days: args.days,
      start: args.start,
      end: args.end,
    });
    const appMode = parseMacroFactorAppMode(args.app);
    const client = await MacroFactorCacheClient.create({ appMode, window });
    const dayDocuments = await fetchFoodLogDays(client, window);
    const [customFoodDetails, programTargets, scaleMetrics, microNutrition] = await Promise.all([
      fetchCustomFoodDetails(client, dayDocuments),
      fetchProgramTargets(client, window),
      fetchScaleMetrics(client, window),
      fetchMicroNutrition(client, window),
    ]);
    const report = buildMacrofactorApiReport({
      sourcePath: SOURCE_PATH,
      dayDocuments,
      customFoodDetails,
      programTargets,
      scaleMetrics,
      microNutrition,
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

async function fetchFoodLogDays(client: MacroFactorCacheClient, window: ResolvedWindow): Promise<ApiFoodLogDay[]> {
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

async function fetchProgramTargets(client: MacroFactorCacheClient, window: ResolvedWindow): Promise<ProgramTarget[]> {
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

async function fetchScaleMetrics(
  client: MacroFactorCacheClient,
  window: ResolvedWindow
): Promise<Record<string, ScaleMetrics>> {
  const years = listWindowYears(window);
  const documents = await Promise.all(
    years.map(async year => ({
      year,
      document: await client.getScaleDocument(year),
    }))
  );
  const metrics: Record<string, ScaleMetrics> = {};

  for (const { year, document } of documents) {
    if (!document) {
      continue;
    }
    for (const [monthDay, rawValue] of Object.entries(document)) {
      const raw = asRecord(rawValue);
      const weightKg = raw ? parseNumberLike(raw.w) : null;
      const bodyFatPct = raw ? parseNumberLike(raw.f) : null;
      if (!raw || !/^\d{4}$/.test(monthDay) || (weightKg == null && bodyFatPct == null)) {
        continue;
      }
      metrics[`${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2)}`] = {
        weightKg,
        bodyFatPct,
      };
    }
  }

  return metrics;
}

async function fetchMicroNutrition(
  client: MacroFactorCacheClient,
  window: ResolvedWindow
): Promise<Record<string, DailyNutritionTotals>> {
  const years = listWindowYears(window);
  const documents = await Promise.all(
    years.map(async year => ({
      year,
      document: await client.getMicroDocument(year),
    }))
  );
  const totals: Record<string, DailyNutritionTotals> = {};

  for (const { year, document } of documents) {
    if (!document) {
      continue;
    }
    for (const [monthDay, rawValue] of Object.entries(document)) {
      if (!/^\d{4}$/.test(monthDay)) {
        continue;
      }
      const raw = asRecord(rawValue);
      if (!raw) {
        continue;
      }
      totals[`${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2)}`] = {
        calories: parseNumberLike(raw.k) ?? 0,
        carbs: parseNumberLike(raw.c) ?? 0,
        protein: parseNumberLike(raw.p) ?? 0,
        fat: parseNumberLike(raw.f) ?? 0,
        fiber: parseNumberLike(raw['291']) ?? parseNumberLike(raw.e) ?? 0,
      };
    }
  }

  return totals;
}

function buildMacrofactorApiReport(options: BuildApiReportOptions): MacrofactorReport {
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
  const rows = entries
    .map(entry => ({
      itemId: entry.itemId,
      title: entry.title,
      brandName: entry.brandName,
      source: entry.source,
      isCustom: entry.isCustom,
      kind: entry.kind,
      recipeId: entry.recipeId,
      firstConsumedAt: formatLocalIso(entry.timestampMs),
      latestConsumedAt: formatLocalIso(entry.timestampMs),
      serving: entry.serving,
      servingGrams: entry.servingGrams,
      nutrition: entry.nutrition,
    }) satisfies MacrofactorFoodRecord)
    .sort((a, b) => Date.parse(b.latestConsumedAt) - Date.parse(a.latestConsumedAt));

  const limitedRows =
    options.limit && Number.isFinite(options.limit) && options.limit > 0
      ? rows.slice(0, Math.floor(options.limit))
      : rows;

  return {
    generatedAt: formatLocalIso(Date.now()),
    sourcePath: options.sourcePath,
    window: {
      start: toIso(window.startUnixSeconds),
      end: toIso(window.endUnixSeconds),
    },
    matchedFoods: rows.length,
    returnedFoods: limitedRows.length,
    dailyOverview: buildDailyOverview(
      window,
      entries,
      options.programTargets ?? [],
      options.scaleMetrics ?? {},
      options.microNutrition ?? {}
    ),
    foods: limitedRows,
    recipeBreakdown: buildRecipeBreakdown(entries, options.customFoodDetails ?? {}),
  };
}

function parseFoodLogTimestamp(entryId: string, fallbackDate?: string, fallbackHour?: unknown, fallbackMinute?: unknown): number | null {
  if (fallbackDate) {
    const [year, month, day] = fallbackDate.split('-').map(part => Number(part));
    if ([year, month, day].every(Number.isFinite)) {
      const hour = parseNumberLike(fallbackHour);
      const minute = parseNumberLike(fallbackMinute);
      if (hour != null && minute != null) {
        const localTimestampMs = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
        if (Number.isFinite(localTimestampMs)) {
          return localTimestampMs;
        }
      }
    }
  }

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
  const fallbackMs = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
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
    const timestampMs = parseFoodLogTimestamp(entryId, day.date, raw.h, raw.mi);
    if (timestampMs == null) {
      continue;
    }

    const itemId = parseString(raw.id) ?? entryId;
    const title = parseString(raw.t) ?? parseString(raw.b) ?? '(untitled)';
    const source = parseString(raw.k);
    const customInfo = customFoodDetails[itemId] ?? { kind: 'food', recipeId: null, ingredients: [] };

    entries.push({
      itemId,
      title,
      brandName: parseOptionalString(raw.b),
      source,
      isCustom: source != null && source !== 't',
      kind: customInfo.kind,
      recipeId: customInfo.recipeId,
      timestampMs,
      consumedDate: formatDateKey(timestampMs),
      serving: buildServingString(parseNumberLike(raw.y), parseOptionalString(raw.u) ?? parseOptionalString(raw.s)),
      servingGrams: computeConsumedGrams(raw),
      nutrition: buildNutrition(raw),
    });
  }

  return entries;
}

function buildNutrition(raw: Record<string, unknown>): MacrofactorFoodRecord['nutrition'] {
  const multiplier = computeNutritionMultiplier(raw);
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

function computeNutritionMultiplier(raw: Record<string, unknown>): number {
  const servingGrams = parseNumberLike(raw.g);
  const userQuantity = parseNumberLike(raw.y);
  const unitWeight = parseNumberLike(raw.w);
  if (servingGrams != null && userQuantity != null && unitWeight != null && servingGrams > 0) {
    return (userQuantity * unitWeight) / servingGrams;
  }
  return 1;
}

function computeConsumedGrams(raw: Record<string, unknown>): number | null {
  const quantity = parseNumberLike(raw.y);
  const displayUnit = parseOptionalString(raw.u) ?? parseOptionalString(raw.s);
  if (quantity == null) {
    return parseNumberLike(raw.g);
  }

  const normalizedUnit = normalizeUnit(displayUnit);
  if (normalizedUnit === 'g') {
    return quantity;
  }
  if (normalizedUnit === 'kg') {
    return quantity * 1000;
  }

  if (normalizedUnit === 'serving') {
    const baseGrams = parseNumberLike(raw.g);
    if (baseGrams != null) {
      return baseGrams > 100 ? baseGrams * computeNutritionMultiplier(raw) : baseGrams * quantity;
    }
  }

  const measuredWeight = lookupMeasurementWeight(raw, displayUnit, quantity);
  if (measuredWeight != null) {
    return measuredWeight;
  }

  return parseNumberLike(raw.g);
}

function lookupMeasurementWeight(
  raw: Record<string, unknown>,
  unit: string | null,
  quantity: number
): number | null {
  if (!unit) {
    return null;
  }
  const measurements = Array.isArray(raw.m) ? raw.m : [];
  for (const rawMeasurement of measurements) {
    const measurement = asRecord(rawMeasurement);
    if (!measurement) {
      continue;
    }
    const measurementUnit = parseOptionalString(measurement.m);
    if (normalizeUnit(measurementUnit) !== normalizeUnit(unit)) {
      continue;
    }
    const measurementQuantity = parseNumberLike(measurement.q);
    const measurementWeight = parseNumberLike(measurement.w);
    if (measurementQuantity == null || measurementWeight == null || measurementQuantity === 0) {
      continue;
    }
    return (quantity * measurementWeight) / measurementQuantity;
  }
  return null;
}

function normalizeUnit(unit: string | null): string | null {
  if (!unit) {
    return null;
  }
  return unit.trim().toLowerCase();
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
  return parseString(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function listFetchDateKeys(window: ResolvedWindow): string[] {
  const startDate = new Date(window.startUnixSeconds * 1000);
  startDate.setDate(startDate.getDate() - 1);
  const endDate = new Date(window.endUnixSeconds * 1000);
  endDate.setDate(endDate.getDate() + 1);
  return listDateKeysBetween(startDate.getTime(), endDate.getTime());
}

function formatDateKey(timestampMs: number): string {
  return formatLocalDateKey(new Date(timestampMs));
}

function buildDailyOverview(
  window: ResolvedWindow,
  entries: ParsedFoodLogEntry[],
  programTargets: ProgramTarget[],
  scaleMetrics: Record<string, ScaleMetrics>,
  microNutrition: Record<string, DailyNutritionTotals>
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
      const scale = scaleMetrics[date];
      const fallback = totalsForDate.foods_logged === 0 ? microNutrition[date] : undefined;
      return {
        date,
        weightKg: roundToSingleDecimal(scale?.weightKg),
        bodyFatPct: roundToSingleDecimal(scale?.bodyFatPct),
        calories: fallback?.calories ?? totalsForDate.calories,
        carbs: fallback?.carbs ?? totalsForDate.carbs,
        protein: fallback?.protein ?? totalsForDate.protein,
        fat: fallback?.fat ?? totalsForDate.fat,
        fiber: fallback?.fiber ?? totalsForDate.fiber,
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
  client: MacroFactorCacheClient,
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
      if (!entry) {
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
  return listWindowYears(window, -1);
}

function listWindowYears(window: ResolvedWindow, startYearOffset = 0): number[] {
  const startYear = new Date(window.startUnixSeconds * 1000).getFullYear() + startYearOffset;
  const endYear = new Date(window.endUnixSeconds * 1000).getFullYear();
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
  return listDateKeysBetween(window.startUnixSeconds * 1000, window.endUnixSeconds * 1000);
}

function renderTable(report: MacrofactorReport, options: { full: boolean }): void {
  process.stdout.write('Daily Overview\n');
  printTable(report.dailyOverview, { valueFormatters: DAILY_OVERVIEW_VALUE_FORMATTERS });
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
    bodyFatPct: row.bodyFatPct,
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

function printTable(
  rows: object[],
  options?: Parameters<typeof renderTableRecords>[1]
): void {
  renderTableRecords(rows, options);
}

function parseMacroFactorAppMode(value: unknown): MacroFactorAppMode {
  if (APP_MODES.includes(value as MacroFactorAppMode)) {
    return value as MacroFactorAppMode;
  }
  throw new Error(`--app must be one of: ${APP_MODES.join(', ')}`);
}

function parseDateArg(value: string, label: string): number {
  const localDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (localDateMatch) {
    const year = Number(localDateMatch[1]);
    const month = Number(localDateMatch[2]);
    const day = Number(localDateMatch[3]);
    const timestamp = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid ${label} date: ${value}`);
    }
    return timestamp / 1000;
  }

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
  return {
    date: formatDate(timestamp, dateFormat),
    time: formatTime(timestamp),
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
    return formatLocalDateKey(d);
  }
  if (format === 'csv') {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }
  const weekday = WEEKDAYS_SHORT[d.getDay()] ?? '';
  const month = MONTHS_LONG[d.getMonth()] ?? '';
  const day = formatOrdinal(d.getDate());
  return `${weekday} ${month} ${day}`.trim();
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatLocalIso(timestamp: number): string {
  const d = new Date(timestamp);
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function formatLocalDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function roundToSingleDecimal(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round((value as number) * 10) / 10;
}

function listDateKeysBetween(startTimestampMs: number, endTimestampMs: number): string[] {
  const current = new Date(startTimestampMs);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endTimestampMs);
  end.setHours(0, 0, 0, 0);
  const dateKeys: string[] = [];

  while (current.getTime() <= end.getTime()) {
    dateKeys.push(formatLocalDateKey(current));
    current.setDate(current.getDate() + 1);
  }

  return dateKeys;
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

class MacroFactorCacheClient {
  private constructor(
    private readonly userPath: string,
    private readonly documents: Map<string, Record<string, unknown>>
  ) {}

  static async create(options: { appMode: MacroFactorAppMode; window: ResolvedWindow }): Promise<MacroFactorCacheClient> {
    const cacheDir = resolveFirestoreCacheDir();
    const dateKeys = listFetchDateKeys(options.window);
    const initialDocuments = await readCachedFirestoreDocuments(cacheDir);
    const initialUserPath = findCachedUserPathOrNull(initialDocuments);
    const shouldReread = await ensureMacroFactorCacheFresh(cacheDir, {
      appMode: options.appMode,
      dateKeys,
      documents: initialDocuments,
      userPath: initialUserPath,
    });
    const documents = shouldReread ? await readCachedFirestoreDocuments(cacheDir) : initialDocuments;
    const userPath = findCachedUserPath(documents);
    return new MacroFactorCacheClient(userPath, documents);
  }

  async getFoodLogDocument(date: string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`food/${date}`);
  }

  async getCustomFoodDocument(id: string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`customFoods/${id}`);
  }

  async getProgramDocument(year: number | string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`program/${year}`);
  }

  async getScaleDocument(year: number | string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`scale/${year}`);
  }

  async getMicroDocument(year: number | string): Promise<Record<string, unknown> | null> {
    return this.getUserDocument(`micro/${year}`);
  }

  private getUserDocument(pathSuffix: string): Record<string, unknown> | null {
    return this.documents.get(`${this.userPath}/${pathSuffix}`) ?? null;
  }
}

function resolveFirestoreCacheDir(): string {
  const containersDir = path.join(os.homedir(), 'Library', 'Containers');
  if (existsSync(containersDir)) {
    for (const entry of readdirSync(containersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const containerDir = path.join(containersDir, entry.name);
      const markerPath = path.join(containerDir, 'Data', 'Library', 'Preferences', `${MACROFACTOR_APP_BUNDLE_ID}.plist`);
      const cacheDir = path.join(containerDir, FIRESTORE_CACHE_RELATIVE_DIR);
      if (existsSync(markerPath) && existsSync(cacheDir)) {
        return cacheDir;
      }
    }
  }

  throw new Error(`MacroFactor Firestore cache was not found. Open ${MACROFACTOR_APP_NAME} once, then rerun this script.`);
}

async function ensureMacroFactorCacheFresh(
  cacheDir: string,
  options: {
    appMode: MacroFactorAppMode;
    dateKeys: string[];
    documents: Map<string, Record<string, unknown>>;
    userPath: string | null;
  }
): Promise<boolean> {
  const syncState = readCacheSyncState();
  const currentCache = readCacheFingerprint(cacheDir);
  const wasRunning = isMacroFactorRunning();

  if (options.appMode === 'none') {
    if (wasRunning) {
      await waitForCacheStable(cacheDir);
      return true;
    }
    return false;
  }

  const appRefreshStale = isMacroFactorAppRefreshStale(syncState, currentCache);
  const warmedRangeCoversRequest = !appRefreshStale && isMacroFactorCacheWarmForDateKeys(syncState, options.dateKeys);
  const missingFoodDateKeys = warmedRangeCoversRequest
    ? []
    : listMissingFoodDateKeys(options.dateKeys, options.userPath, options.documents);
  const shouldOpen =
    options.appMode === 'open' ||
    !options.userPath ||
    appRefreshStale ||
    missingFoodDateKeys.length > 0;

  if (!shouldOpen) {
    if (wasRunning) {
      await waitForCacheStable(cacheDir);
      return true;
    }
    return false;
  }

  await warmMacroFactorAppCache(cacheDir, options.dateKeys);
  const nextSyncState: CacheSyncState = {
    refreshedDate: formatLocalDateKey(new Date()),
    refreshedAt: formatLocalIso(Date.now()),
    appOpenedAt: formatLocalIso(Date.now()),
    warmedAt: formatLocalIso(Date.now()),
    cacheMtimeMs: readCacheFingerprint(cacheDir)?.latestMtimeMs,
  };
  const warmedStartDate = options.dateKeys[0];
  const warmedEndDate = options.dateKeys.at(-1);
  if (warmedStartDate) {
    nextSyncState.warmedStartDate = warmedStartDate;
  }
  if (warmedEndDate) {
    nextSyncState.warmedEndDate = warmedEndDate;
  }
  writeCacheSyncState(nextSyncState);

  if (!wasRunning) {
    closeMacroFactorApp();
    await waitForMacroFactorExit();
  }

  return true;
}

function listMissingFoodDateKeys(
  dateKeys: string[],
  userPath: string | null,
  documents: Map<string, Record<string, unknown>>
): string[] {
  if (!userPath) {
    return dateKeys;
  }
  return dateKeys.filter(date => !documents.has(`${userPath}/food/${date}`));
}

function isMacroFactorAppRefreshStale(syncState: CacheSyncState | null, currentCache: CacheFingerprint | null): boolean {
  const lastScriptOpenMs = parseLocalTimestampMs(syncState?.appOpenedAt ?? syncState?.refreshedAt);
  const lastActivityMs = Math.max(lastScriptOpenMs ?? 0, currentCache?.latestMtimeMs ?? 0);
  return !lastActivityMs || Date.now() - lastActivityMs >= APP_REFRESH_INTERVAL_MS;
}

function isMacroFactorCacheWarmForDateKeys(syncState: CacheSyncState | null, dateKeys: string[]): boolean {
  const firstDate = dateKeys[0];
  const lastDate = dateKeys.at(-1);
  if (!firstDate || !lastDate) {
    return true;
  }
  return Boolean(
    syncState?.warmedStartDate &&
      syncState.warmedStartDate <= firstDate &&
      syncState?.warmedEndDate &&
      syncState.warmedEndDate >= lastDate
  );
}

function parseLocalTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function warmMacroFactorAppCache(cacheDir: string, dateKeys: string[]): Promise<void> {
  openMacroFactorApp();
  await waitForMacroFactorRunning();
  await sleep(APP_UI_SETTLE_MS);
  dismissMacroFactorRestoreDialog();

  const frame = await waitForMacroFactorWindowFrame();
  clickMacroFactorWindowPoint(frame, 0.3, 0.965);
  await sleep(APP_UI_SETTLE_MS * 2);

  await moveMacroFactorFoodLogToToday(frame);
  await walkMacroFactorFoodLogDates(frame, dateKeys);
  await waitForCacheStable(cacheDir);
}

async function waitForMacroFactorRunning(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < APP_LAUNCH_TIMEOUT_MS) {
    if (isMacroFactorRunning()) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${MACROFACTOR_APP_NAME} to launch.`);
}

interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function waitForMacroFactorWindowFrame(): Promise<WindowFrame> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < APP_LAUNCH_TIMEOUT_MS) {
    const frame = getMacroFactorWindowFrame();
    if (frame && frame.width > 250 && frame.height > 250) {
      return frame;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for the ${MACROFACTOR_APP_NAME} window.`);
}

function getMacroFactorWindowFrame(): WindowFrame | null {
  return getMacroFactorWindowFrameFromCoreGraphics() ?? getMacroFactorWindowFrameFromSystemEvents();
}

function getMacroFactorWindowFrameFromCoreGraphics(): WindowFrame | null {
  const script = `
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let matches = windows.filter { window in
  guard let owner = window[kCGWindowOwnerName as String] as? String,
        let layer = window[kCGWindowLayer as String] as? Int,
        let bounds = window[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? Double,
        let height = bounds["Height"] as? Double else { return false }
  return owner == "${MACROFACTOR_APP_NAME}" && layer == 0 && width > 250 && height > 250
}
if let window = matches.first,
   let bounds = window[kCGWindowBounds as String] as? [String: Any],
   let x = bounds["X"] as? Double,
   let y = bounds["Y"] as? Double,
   let width = bounds["Width"] as? Double,
   let height = bounds["Height"] as? Double {
  print("\\(Int(x)),\\(Int(y)),\\(Int(width)),\\(Int(height))")
}
`.trim();
  const result = spawnSync('swift', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return parseWindowFrame(result.stdout);
}

function getMacroFactorWindowFrameFromSystemEvents(): WindowFrame | null {
  const script = `
tell application "System Events"
  if not (exists process "${MACROFACTOR_APP_NAME}") then return ""
  tell process "${MACROFACTOR_APP_NAME}"
    set frontmost to true
    if not (exists window 1) then return ""
    set p to position of window 1
    set s to size of window 1
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell
`.trim();
  const result = spawnSync('osascript', [], { input: script, encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return parseWindowFrame(result.stdout);
}

function parseWindowFrame(output: string): WindowFrame | null {
  const parts = output.trim().split(',').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
    return null;
  }
  return {
    x: parts[0],
    y: parts[1],
    width: parts[2],
    height: parts[3],
  };
}

function dismissMacroFactorRestoreDialog(): void {
  const script = `
tell application "System Events"
  if not (exists process "${MACROFACTOR_APP_NAME}") then return
  tell process "${MACROFACTOR_APP_NAME}"
    set frontmost to true
    if not (exists window 1) then return
    try
      if description of window 1 is "alert" and (count of buttons of window 1) >= 2 then
        click button 2 of window 1
      end if
    end try
  end tell
end tell
`.trim();
  spawnSync('osascript', [], { input: script, encoding: 'utf8' });
}

async function moveMacroFactorFoodLogToToday(frame: WindowFrame): Promise<void> {
  clickMacroFactorWindowPoint(frame, 0.5, 0.075);
  await sleep(APP_UI_SETTLE_MS);
  clickMacroFactorAbsolutePoint(frame.x + frame.width * 0.265, frame.y + frame.height - 98);
  await sleep(APP_UI_SETTLE_MS);
}

async function walkMacroFactorFoodLogDates(frame: WindowFrame, dateKeys: string[]): Promise<void> {
  const today = formatLocalDateKey(new Date());
  const dateOffsets = dateKeys
    .map(date => localDateOffset(today, date))
    .filter((offset): offset is number => offset != null);
  if (dateOffsets.length === 0) {
    return;
  }

  const futureDays = Math.max(0, ...dateOffsets);
  for (let index = 0; index < futureDays; index += 1) {
    clickMacroFactorWindowPoint(frame, 0.64, 0.075);
    await sleep(APP_DAY_NAVIGATION_SETTLE_MS);
  }

  if (futureDays > 0) {
    await moveMacroFactorFoodLogToToday(frame);
  }

  const pastDays = Math.abs(Math.min(0, ...dateOffsets));
  for (let index = 0; index < pastDays; index += 1) {
    clickMacroFactorWindowPoint(frame, 0.36, 0.075);
    await sleep(APP_DAY_NAVIGATION_SETTLE_MS);
  }
}

function localDateOffset(fromDate: string, toDate: string): number | null {
  const from = localDateNoonMs(fromDate);
  const to = localDateNoonMs(toDate);
  if (from == null || to == null) {
    return null;
  }
  return Math.round((to - from) / (SECONDS_PER_DAY * 1000));
}

function localDateNoonMs(dateKey: string): number | null {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const timestamp = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clickMacroFactorWindowPoint(frame: WindowFrame, xRatio: number, yRatio: number): void {
  clickMacroFactorAbsolutePoint(frame.x + frame.width * xRatio, frame.y + frame.height * yRatio);
}

function clickMacroFactorAbsolutePoint(x: number, y: number): void {
  const script = `
tell application "System Events"
  if exists process "${MACROFACTOR_APP_NAME}" then set frontmost of process "${MACROFACTOR_APP_NAME}" to true
  click at {${Math.round(x)}, ${Math.round(y)}}
end tell
`.trim();
  const result = spawnSync('osascript', [], { input: script, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(commandError(result, `Failed to click ${MACROFACTOR_APP_NAME}.`));
  }
}

function readCacheSyncState(): CacheSyncState | null {
  if (!existsSync(CACHE_SYNC_STATE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(CACHE_SYNC_STATE_PATH, 'utf8')) as CacheSyncState;
  } catch {
    return null;
  }
}

function writeCacheSyncState(state: CacheSyncState): void {
  mkdirSync(path.dirname(CACHE_SYNC_STATE_PATH), { recursive: true });
  writeFileSync(CACHE_SYNC_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function isMacroFactorRunning(): boolean {
  const result = spawnSync('osascript', ['-e', `application id "${MACROFACTOR_APP_BUNDLE_ID}" is running`], {
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function openMacroFactorApp(): void {
  const result = spawnSync('open', ['-b', MACROFACTOR_APP_BUNDLE_ID], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(commandError(result, `Failed to open ${MACROFACTOR_APP_NAME}.`));
  }
}

function closeMacroFactorApp(): void {
  const result = spawnSync('osascript', ['-e', `quit app id "${MACROFACTOR_APP_BUNDLE_ID}"`], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(commandError(result, `Failed to quit ${MACROFACTOR_APP_NAME}.`));
  }
}

async function waitForMacroFactorExit(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (!isMacroFactorRunning()) {
      return;
    }
    await sleep(500);
  }
}

function commandError(result: { stdout?: unknown; stderr?: unknown }, fallback: string): string {
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  return output ? `${fallback} ${output}` : fallback;
}

interface CacheFingerprint {
  latestMtimeMs: number;
  value: string;
}

function readCacheFingerprint(cacheDir: string): CacheFingerprint | null {
  if (!existsSync(cacheDir)) {
    return null;
  }
  const parts: string[] = [];
  let latestMtimeMs = 0;
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'LOCK') {
      continue;
    }
    const filePath = path.join(cacheDir, entry.name);
    const stats = statSync(filePath);
    latestMtimeMs = Math.max(latestMtimeMs, stats.mtimeMs);
    parts.push(`${entry.name}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
  }
  parts.sort();
  return {
    latestMtimeMs,
    value: parts.join('|'),
  };
}

async function waitForCacheStable(cacheDir: string): Promise<void> {
  const start = Date.now();
  let latest = readCacheFingerprint(cacheDir);
  let stableSince = Date.now();

  while (Date.now() - start < 10_000) {
    await sleep(CACHE_REFRESH_POLL_MS);
    const current = readCacheFingerprint(cacheDir);
    if (current?.value !== latest?.value) {
      latest = current;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= 2_000) {
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readCachedFirestoreDocuments(cacheDir: string): Promise<Map<string, Record<string, unknown>>> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'macrofactor-firestore-cache-'));
  const snapshotDir = path.join(tempDir, 'main');
  try {
    cpSync(cacheDir, snapshotDir, { recursive: true });
    const db = new ClassicLevel<Buffer, Buffer>(snapshotDir, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
    });
    const documents = new Map<string, Record<string, unknown>>();
    try {
      for await (const [rawKey, rawValue] of db.iterator()) {
        const key = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey as Uint8Array);
        const value = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue as Uint8Array);
        const documentPath = decodeRemoteDocumentPath(key);
        if (!documentPath) {
          continue;
        }
        const document = parseRemoteDocumentValue(value);
        if (document) {
          documents.set(documentPath, document.fields);
        }
      }
    } finally {
      await db.close();
    }
    return documents;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function decodeRemoteDocumentPath(key: Buffer): string | null {
  const tokens = key.toString('utf8').match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  if (tokens[0] !== 'remote_document') {
    return null;
  }
  return tokens.slice(1).join('/');
}

function findCachedUserPath(documents: Map<string, Record<string, unknown>>): string {
  const userPath = findCachedUserPathOrNull(documents);
  if (!userPath) {
    throw new Error(`MacroFactor Firestore cache does not contain a user document. Open ${MACROFACTOR_APP_NAME}, wait for sync, then rerun.`);
  }
  return userPath;
}

function findCachedUserPathOrNull(documents: Map<string, Record<string, unknown>>): string | null {
  const users = Array.from(documents.keys())
    .filter(documentPath => /^users\/[^/]+$/.test(documentPath))
    .sort();
  return users[0] ?? null;
}

interface ParsedRemoteDocument {
  name: string;
  fields: Record<string, unknown>;
}

function parseRemoteDocumentValue(value: Buffer): ParsedRemoteDocument | null {
  const reader = new ProtoReader(value);
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 2 && tag.wireType === 2) {
      return parseFirestoreDocument(reader.readBytes());
    }
    reader.skip(tag.wireType);
  }
  return null;
}

function parseFirestoreDocument(value: Buffer): ParsedRemoteDocument {
  const reader = new ProtoReader(value);
  const fields: Record<string, unknown> = {};
  let name = '';
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      name = reader.readBytes().toString('utf8');
    } else if (tag.field === 2) {
      const [key, fieldValue] = parseFirestoreFieldEntry(reader.readBytes());
      fields[key] = fieldValue;
    } else {
      reader.skip(tag.wireType);
    }
  }
  return { name, fields };
}

function parseFirestoreFieldEntry(value: Buffer): [string, unknown] {
  const reader = new ProtoReader(value);
  let key = '';
  let fieldValue: unknown = null;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      key = reader.readBytes().toString('utf8');
    } else if (tag.field === 2) {
      fieldValue = parseFirestoreProtoValue(reader.readBytes());
    } else {
      reader.skip(tag.wireType);
    }
  }
  return [key, fieldValue];
}

function parseFirestoreProtoValue(value: Buffer): unknown {
  const reader = new ProtoReader(value);
  let parsed: unknown = null;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      parsed = Boolean(reader.readVarint());
    } else if (tag.field === 2) {
      const integer = decodeSignedInt64(reader.readVarint());
      const numeric = Number(integer);
      parsed = Number.isSafeInteger(numeric) ? numeric : integer.toString();
    } else if (tag.field === 3) {
      parsed = reader.readDouble();
    } else if (tag.field === 5) {
      parsed = reader.readBytes().toString('utf8');
    } else if (tag.field === 6) {
      parsed = parseFirestoreMapValue(reader.readBytes());
    } else if (tag.field === 8) {
      parsed = parseFirestoreGeoPointValue(reader.readBytes());
    } else if (tag.field === 9) {
      parsed = parseFirestoreArrayValue(reader.readBytes());
    } else if (tag.field === 10) {
      parsed = parseFirestoreTimestampValue(reader.readBytes());
    } else if (tag.field === 11) {
      reader.readVarint();
      parsed = null;
    } else if (tag.field === 17) {
      parsed = reader.readBytes().toString('utf8');
    } else if (tag.field === 18) {
      parsed = reader.readBytes().toString('base64');
    } else {
      reader.skip(tag.wireType);
    }
  }
  return parsed;
}

function parseFirestoreMapValue(value: Buffer): Record<string, unknown> {
  const reader = new ProtoReader(value);
  const fields: Record<string, unknown> = {};
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      const [key, fieldValue] = parseFirestoreFieldEntry(reader.readBytes());
      fields[key] = fieldValue;
    } else {
      reader.skip(tag.wireType);
    }
  }
  return fields;
}

function parseFirestoreArrayValue(value: Buffer): unknown[] {
  const reader = new ProtoReader(value);
  const values: unknown[] = [];
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      values.push(parseFirestoreProtoValue(reader.readBytes()));
    } else {
      reader.skip(tag.wireType);
    }
  }
  return values;
}

function parseFirestoreTimestampValue(value: Buffer): string {
  const reader = new ProtoReader(value);
  let seconds = 0n;
  let nanos = 0;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      seconds = decodeSignedInt64(reader.readVarint());
    } else if (tag.field === 2) {
      nanos = Number(reader.readVarint());
    } else {
      reader.skip(tag.wireType);
    }
  }
  return new Date(Number(seconds) * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

function parseFirestoreGeoPointValue(value: Buffer): { latitude: number | null; longitude: number | null } {
  const reader = new ProtoReader(value);
  let latitude: number | null = null;
  let longitude: number | null = null;
  while (!reader.eof()) {
    const tag = reader.readTag();
    if (tag.field === 1) {
      latitude = reader.readDouble();
    } else if (tag.field === 2) {
      longitude = reader.readDouble();
    } else {
      reader.skip(tag.wireType);
    }
  }
  return { latitude, longitude };
}

const MAX_INT64 = (1n << 63n) - 1n;
const TWO_64 = 1n << 64n;

function decodeSignedInt64(value: bigint): bigint {
  return value > MAX_INT64 ? value - TWO_64 : value;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  eof(): boolean {
    return this.offset >= this.data.length;
  }

  readTag(): { field: number; wireType: number } {
    const tag = Number(this.readVarint());
    return {
      field: tag >> 3,
      wireType: tag & 7,
    };
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.offset < this.data.length) {
      const byte = this.data[this.offset++] ?? 0;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
    throw new Error('Unexpected end of protobuf varint.');
  }

  readBytes(): Buffer {
    const length = Number(this.readVarint());
    const end = this.offset + length;
    if (end > this.data.length) {
      throw new Error('Unexpected end of protobuf length-delimited field.');
    }
    const value = this.data.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  readDouble(): number {
    const value = this.data.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 1) {
      this.offset += 8;
      return;
    }
    if (wireType === 2) {
      const length = Number(this.readVarint());
      this.offset += length;
      return;
    }
    if (wireType === 5) {
      this.offset += 4;
      return;
    }
    throw new Error(`Unsupported protobuf wire type ${wireType}.`);
  }
}
