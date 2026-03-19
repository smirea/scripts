#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import {
  OUTPUT_FORMATS,
  parseOutputFormat,
  renderOutput,
  resolveWindow,
  toIso,
  type MacrofactorDailyOverviewRecord,
  type MacrofactorFoodRecord,
  type MacrofactorRecipeBreakdownRecord,
  type MacrofactorReport,
  type ResolvedWindow,
} from './macrofactor-report';
import { MacroFactorApiClient } from './utils/macrofactorApi';

const SOURCE_PATH = 'api://macrofactor/food-log';
const FOOD_DOC_BATCH_SIZE = 10;
const SECONDS_PER_DAY = 24 * 60 * 60;
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

interface BuildApiReportOptions {
  sourcePath: string;
  dayDocuments: ApiFoodLogDay[];
  customFoodDetails?: Record<string, CustomFoodDetails>;
  programTargets?: ProgramTarget[];
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

if (import.meta.main) {
  void runCli();
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
    const [customFoodDetails, programTargets] = await Promise.all([
      fetchCustomFoodDetails(client, dayDocuments),
      fetchProgramTargets(client, window),
    ]);
    const report = buildMacrofactorApiReport({
      sourcePath: SOURCE_PATH,
      dayDocuments,
      customFoodDetails,
      programTargets,
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
    dailyOverview: buildDailyOverview(window, entries, options.programTargets ?? []),
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
  programTargets: ProgramTarget[]
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

  return Array.from(totals.entries()).map(([date, totalsForDate]) => {
    const goals = findProgramGoalsForDate(date, programTargets);
    return {
      date,
      calories: roundNumber(totalsForDate.calories, 0),
      carbs: roundNumber(totalsForDate.carbs, 2),
      protein: roundNumber(totalsForDate.protein, 2),
      fat: roundNumber(totalsForDate.fat, 2),
      fiber: roundNumber(totalsForDate.fiber, 2),
      goal_calories: goals.goal_calories,
      goal_protein: goals.goal_protein,
      goal_carbs: goals.goal_carbs,
      goal_fat: goals.goal_fat,
      foods_logged: totalsForDate.foods_logged,
    };
  });
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
    .sort((a, b) => a.name.localeCompare(b.name));
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
    goal_calories: pickProgramValue(activeTarget.calories, activeTarget.effectiveDate, date, 0),
    goal_protein: pickProgramValue(activeTarget.protein, activeTarget.effectiveDate, date, 2),
    goal_carbs: pickProgramValue(activeTarget.carbs, activeTarget.effectiveDate, date, 2),
    goal_fat: pickProgramValue(activeTarget.fat, activeTarget.effectiveDate, date, 2),
  };
}

function pickProgramValue(
  values: Array<number | null>,
  effectiveDate: string,
  date: string,
  fractionDigits: number
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
  return value == null ? null : roundNumber(value, fractionDigits);
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

function roundNumber(value: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round(value * factor) / factor;
}
