#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  APPLE_REFERENCE_UNIX_SECONDS,
  OUTPUT_FORMATS,
  parseOutputFormat,
  renderOutput,
  resolveWindow,
  toIso,
  type MacrofactorFoodRecord,
  type MacrofactorReport,
} from './macrofactor-report';

export {
  APPLE_REFERENCE_UNIX_SECONDS,
  renderCsv,
  resolveWindow,
  toConciseRows,
  type MacrofactorConciseRow,
  type MacrofactorFoodRecord,
  type MacrofactorReport,
  type OutputFormat,
} from './macrofactor-report';

const APP_NAME = 'MacroFactor';
const APP_SYNC_WAIT_MILLISECONDS = 12_000;
const APP_SYNC_SKIP_WINDOW_MILLISECONDS = 60 * 60 * 1000;
const APP_SYNC_STATE_FILENAME = 'macrofactor-sync.json';

interface HistoryFile {
  food: Record<string, HistoryFoodEntry>;
}

interface HistoryFoodEntry {
  itemId?: string;
  firstConsumedTimeUTC?: number;
  latestConsumedTimeUTC?: number;
  food?: {
    title?: string;
    brandName?: string;
    source?: string;
    isCustom?: boolean;
    recipe?: unknown[];
    servingDefault?: unknown;
    servingUserSelection?: unknown;
    servingAlternatives?: unknown[];
    micros?: unknown[];
  };
}

interface BuildOptions {
  sourcePath: string;
  jsonText: string;
  days: number;
  start?: string;
  end?: string;
  limit?: number;
  nowUnixSeconds?: number;
}

if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  try {
    const defaultSourcePath = getDefaultSourcePath();
    const args = await yargs(hideBin(process.argv))
      .scriptName('macrofactor')
      .strict()
      .option('source', {
        alias: ['s'],
        type: 'string',
        default: defaultSourcePath,
        describe: 'Path to MacroFactor historyFood.json',
      })
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
      .option('app', {
        type: 'boolean',
        default: true,
        describe: 'Open MacroFactor and refresh cache before export when local sync is stale',
      })
      .help()
      .parseAsync();

    if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
      throw new Error('--limit must be a positive number.');
    }

    const sourcePath = path.resolve(args.source);
    if (args.app) {
      await syncFromMacrofactorAppIfNeeded({
        sourcePath,
      });
    }
    if (!existsSync(sourcePath)) {
      throw new Error(`Source file does not exist: ${sourcePath}`);
    }

    const jsonText = readFileSync(sourcePath, 'utf8');
    const report = buildMacrofactorReport({
      sourcePath,
      jsonText,
      days: args.days,
      start: args.start,
      end: args.end,
      limit: args.limit,
    });
    const format = parseOutputFormat(args.format);

    renderOutput({
      report,
      format,
      outputPath: args.output,
      pretty: args.pretty,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

function getDefaultSourcePath(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  return path.join(home, 'Library', 'Group Containers', 'group.com.sbs.diet.widgetgroup', 'historyFood.json');
}

async function syncFromMacrofactorAppIfNeeded(options: { sourcePath: string }): Promise<void> {
  const sourceExists = existsSync(options.sourcePath);
  const nowMilliseconds = Date.now();
  const lastFileSyncMilliseconds = sourceExists ? getFileModifiedMilliseconds(options.sourcePath) : null;
  const lastRecordedAppOpenMilliseconds = readLastAppOpenMilliseconds();
  const isRunning = isAppRunning(APP_NAME);
  const runningAppAgeSeconds = isRunning ? getRunningAppAgeSeconds(APP_NAME) : null;
  const lastAppLaunchMilliseconds =
    runningAppAgeSeconds != null ? nowMilliseconds - runningAppAgeSeconds * 1000 : null;
  const lastSyncMilliseconds = maxFinite(
    lastFileSyncMilliseconds,
    maxFinite(lastRecordedAppOpenMilliseconds, lastAppLaunchMilliseconds)
  );
  if (
    !shouldSyncFromApp({
      lastSyncMilliseconds,
      nowMilliseconds,
      skipWindowMilliseconds: APP_SYNC_SKIP_WINDOW_MILLISECONDS,
      force: !sourceExists,
    })
  ) {
    return;
  }

  if (isRunning) {
    writeLastAppOpenMilliseconds(nowMilliseconds);
    console.error(chalk.yellow(`${APP_NAME} is already running. Waiting briefly for it to sync...`));
    await sleep(APP_SYNC_WAIT_MILLISECONDS);
    return;
  }

  console.error(chalk.yellow(`Opening the ${APP_NAME} app to sync...`));
  runCommandOrThrow('open', ['-a', APP_NAME], `Failed to open ${APP_NAME}.`);
  writeLastAppOpenMilliseconds(nowMilliseconds);
  await sleep(APP_SYNC_WAIT_MILLISECONDS);
  runCommandOrThrow('osascript', ['-e', `tell application "${APP_NAME}" to quit`], `Failed to quit ${APP_NAME}.`);
}

export function shouldSyncFromApp(options: {
  lastSyncMilliseconds: number | null;
  nowMilliseconds: number;
  skipWindowMilliseconds: number;
  force: boolean;
}): boolean {
  if (options.force) {
    return true;
  }
  if (!isFiniteNumber(options.lastSyncMilliseconds)) {
    return true;
  }
  return options.nowMilliseconds - options.lastSyncMilliseconds >= options.skipWindowMilliseconds;
}

function getFileModifiedMilliseconds(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

function isAppRunning(appName: string): boolean {
  const result = spawnSync(
    'osascript',
    [
      '-e',
      `tell application "System Events" to (name of processes) contains "${appName.replaceAll('"', '\\"')}"`,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    return false;
  }
  return `${result.stdout ?? ''}`.trim().toLowerCase() === 'true';
}

function getRunningAppAgeSeconds(appName: string): number | null {
  const pidResult = spawnSync('pgrep', ['-x', appName], { encoding: 'utf8' });
  if (pidResult.status !== 0) {
    return null;
  }
  const pid = `${pidResult.stdout ?? ''}`.trim().split(/\s+/)[0];
  if (!pid) {
    return null;
  }
  const elapsedResult = spawnSync('ps', ['-o', 'etimes=', '-p', pid], { encoding: 'utf8' });
  if (elapsedResult.status !== 0) {
    return null;
  }
  const elapsedSeconds = Number(`${elapsedResult.stdout ?? ''}`.trim());
  return Number.isFinite(elapsedSeconds) ? elapsedSeconds : null;
}

function getSyncStatePath(): string | null {
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  const dir = path.join(home, 'Library', 'Caches', 'scripts');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, APP_SYNC_STATE_FILENAME);
}

function readLastAppOpenMilliseconds(): number | null {
  const statePath = getSyncStatePath();
  if (!statePath || !existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
    const value =
      parsed && typeof parsed === 'object' && 'lastAppOpenMilliseconds' in parsed
        ? (parsed as { lastAppOpenMilliseconds?: unknown }).lastAppOpenMilliseconds
        : null;
    return isFiniteNumber(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastAppOpenMilliseconds(nowMilliseconds: number): void {
  const statePath = getSyncStatePath();
  if (!statePath) {
    return;
  }
  writeFileSync(statePath, `${JSON.stringify({ lastAppOpenMilliseconds: nowMilliseconds })}\n`, 'utf8');
}

function maxFinite(a: number | null, b: number | null): number | null {
  const aOk = isFiniteNumber(a);
  const bOk = isFiniteNumber(b);
  if (aOk && bOk) {
    return Math.max(a, b);
  }
  if (aOk) {
    return a;
  }
  if (bOk) {
    return b;
  }
  return null;
}

function runCommandOrThrow(command: string, args: string[], errorPrefix: string): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status === 0) {
    return;
  }
  const stderr = `${result.stderr ?? ''}`.trim();
  const stdout = `${result.stdout ?? ''}`.trim();
  const details = stderr || stdout;
  throw new Error(details ? `${errorPrefix} ${details}` : errorPrefix);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function buildMacrofactorReport(options: BuildOptions): MacrofactorReport {
  const input = parseHistoryJson(options.jsonText);
  const window = resolveWindow({
    days: options.days,
    start: options.start,
    end: options.end,
    nowUnixSeconds: options.nowUnixSeconds,
  });

  const rows: MacrofactorFoodRecord[] = [];
  for (const value of Object.values(input.food)) {
    const row = toFoodRow(value, window.startUnixSeconds, window.endUnixSeconds);
    if (row) {
      rows.push(row);
    }
  }

  rows.sort((a, b) => Date.parse(b.latestConsumedAt) - Date.parse(a.latestConsumedAt));

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

function parseHistoryJson(jsonText: string): HistoryFile {
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== 'object' || !('food' in parsed)) {
    throw new Error('Invalid MacroFactor history file: missing top-level `food`.');
  }
  const food = (parsed as { food?: unknown }).food;
  if (!food || typeof food !== 'object' || Array.isArray(food)) {
    throw new Error('Invalid MacroFactor history file: `food` must be an object.');
  }
  return parsed as HistoryFile;
}

function toFoodRow(
  entry: HistoryFoodEntry,
  startUnixSeconds: number,
  endUnixSeconds: number
): MacrofactorFoodRecord | null {
  const latestAppleSeconds = entry.latestConsumedTimeUTC;
  if (!isFiniteNumber(latestAppleSeconds)) {
    return null;
  }
  const latestUnixSeconds = appleToUnixSeconds(latestAppleSeconds);
  if (latestUnixSeconds < startUnixSeconds || latestUnixSeconds > endUnixSeconds) {
    return null;
  }

  const firstAppleSeconds = entry.firstConsumedTimeUTC;
  const firstUnixSeconds = isFiniteNumber(firstAppleSeconds) ? appleToUnixSeconds(firstAppleSeconds) : null;
  const food = entry.food ?? {};
  const title = toStringOrNull(food.title) ?? toStringOrNull(food.brandName) ?? '(untitled)';
  const byCode = parseMicros(food.micros);

  const named: Record<string, number> = {};
  for (const [key, value] of Object.entries(byCode)) {
    const mapped = CODE_NAME_MAP[key];
    if (mapped) {
      named[mapped] = value;
    }
  }

  const recipe = Array.isArray(food.recipe) ? food.recipe : [];
  const servingAlternatives = Array.isArray(food.servingAlternatives) ? food.servingAlternatives : [];

  return {
    itemId: toStringOrNull(entry.itemId) ?? '(missing-item-id)',
    title,
    brandName: toStringOrNull(food.brandName),
    source: toStringOrNull(food.source),
    isCustom: Boolean(food.isCustom),
    firstConsumedAt: firstUnixSeconds ? toIso(firstUnixSeconds) : null,
    latestConsumedAt: toIso(latestUnixSeconds),
    recipeCount: recipe.length,
    recipe,
    servingDefault: food.servingDefault ?? null,
    servingUserSelection: food.servingUserSelection ?? null,
    servingAlternatives,
    nutrition: {
      caloriesKcal: maybeNumber(byCode.k),
      proteinG: maybeNumber(byCode.p),
      carbsG: maybeNumber(byCode.c),
      fatG: maybeNumber(byCode.f),
      fiberG: maybeNumber(byCode.e),
      sugarG: maybeNumber(byCode.s),
      netCarbsG: maybeNumber(byCode.nc),
      alcoholG: maybeNumber(byCode.a),
      byCode,
      named,
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function maybeNumber(value: unknown): number | null {
  return Number.isFinite(value) ? (value as number) : null;
}

function parseMicros(micros: unknown[] | undefined): Record<string, number> {
  if (!Array.isArray(micros)) {
    return {};
  }
  const byCode: Record<string, number> = {};
  for (let i = 0; i + 1 < micros.length; i += 2) {
    const codeRaw = micros[i];
    const valueRaw = micros[i + 1];
    const code = String(codeRaw);
    const value =
      typeof valueRaw === "number"
        ? valueRaw
        : typeof valueRaw === "string"
          ? Number(valueRaw)
          : Number.NaN;
    if (!Number.isFinite(value)) {
      continue;
    }
    byCode[code] = value;
  }
  return byCode;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function appleToUnixSeconds(secondsSince2001: number): number {
  return secondsSince2001 + APPLE_REFERENCE_UNIX_SECONDS;
}

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
