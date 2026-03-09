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
  type MacrofactorFoodRecord,
  type MacrofactorReport,
  type ResolvedWindow,
} from './macrofactor-report';
import { MacroFactorApiClient } from './utils/macrofactorApi';

const SOURCE_PATH = 'api://macrofactor/food-log';
const FOOD_DOC_BATCH_SIZE = 10;
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
  consumedAt: string;
  timestampMs: number;
  servingDefault: unknown;
  servingUserSelection: unknown;
  servingAlternatives: unknown[];
  nutrition: MacrofactorFoodRecord['nutrition'];
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
    const report = buildMacrofactorApiReport({
      sourcePath: SOURCE_PATH,
      dayDocuments,
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

export function buildMacrofactorApiReport(options: BuildApiReportOptions): MacrofactorReport {
  const window = resolveWindow({
    days: options.days,
    start: options.start,
    end: options.end,
    nowUnixSeconds: options.nowUnixSeconds,
  });
  const startMs = window.startUnixSeconds * 1000;
  const endMs = window.endUnixSeconds * 1000;
  const groups = new Map<
    string,
    {
      firstTimestampMs: number;
      latestTimestampMs: number;
      representative: ParsedFoodLogEntry;
    }
  >();

  for (const day of options.dayDocuments) {
    for (const entry of parseFoodLogEntries(day)) {
      if (entry.timestampMs < startMs || entry.timestampMs > endMs) {
        continue;
      }
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
        firstConsumedAt: new Date(group.firstTimestampMs).toISOString(),
        latestConsumedAt: new Date(group.latestTimestampMs).toISOString(),
        recipeCount: 0,
        recipe: [],
        servingDefault: representative.servingDefault,
        servingUserSelection: representative.servingUserSelection,
        servingAlternatives: representative.servingAlternatives,
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
    foods: limitedRows,
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

function parseFoodLogEntries(day: ApiFoodLogDay): ParsedFoodLogEntry[] {
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

    entries.push({
      groupKey: itemId,
      itemId,
      title,
      brandName: parseOptionalString(raw.b),
      source,
      isCustom: source != null && source !== 't',
      consumedAt: new Date(timestampMs).toISOString(),
      timestampMs,
      servingDefault: buildServing(parseNumberLike(raw.q), parseOptionalString(raw.s)),
      servingUserSelection: buildServing(parseNumberLike(raw.y), parseOptionalString(raw.s)),
      servingAlternatives: buildServingAlternatives(raw.m),
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

function buildServing(quantity: number | null, name: string | null): { quantity?: number; name?: string } | null {
  if (quantity == null && name == null) {
    return null;
  }
  const serving: { quantity?: number; name?: string } = {};
  if (quantity != null) {
    serving.quantity = quantity;
  }
  if (name != null) {
    serving.name = name;
  }
  return serving;
}

function buildServingAlternatives(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(item => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    const name = parseOptionalString(record.m);
    const quantity = parseNumberLike(record.q);
    const weight = parseNumberLike(record.w);
    if (name == null && quantity == null && weight == null) {
      return [];
    }
    return [
      {
        ...(name != null ? { name } : {}),
        ...(quantity != null ? { quantity } : {}),
        ...(weight != null ? { weight } : {}),
      },
    ];
  });
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
