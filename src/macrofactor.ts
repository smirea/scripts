#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import chalk from "chalk";

export const APPLE_REFERENCE_UNIX_SECONDS = 978307200;
const SECONDS_PER_DAY = 24 * 60 * 60;
const CSV_COLUMNS = [
  "date",
  "time",
  "name",
  "serving",
  "calories",
  "protein",
  "carbs",
  "fat",
  "fiber",
] as const;
const OUTPUT_FORMATS = ["json", "table", "csv"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
const APP_NAME = "MacroFactor";
const APP_SYNC_WAIT_MILLISECONDS = 12_000;
const APP_SYNC_SKIP_WINDOW_MILLISECONDS = 60 * 60 * 1000;

export interface MacrofactorReport {
  generatedAt: string;
  sourcePath: string;
  window: {
    start: string;
    end: string;
  };
  matchedFoods: number;
  returnedFoods: number;
  foods: MacrofactorFoodRecord[];
}

export interface MacrofactorFoodRecord {
  itemId: string;
  title: string;
  brandName: string | null;
  source: string | null;
  isCustom: boolean;
  firstConsumedAt: string | null;
  latestConsumedAt: string;
  recipeCount: number;
  recipe: unknown[];
  servingDefault: unknown;
  servingUserSelection: unknown;
  servingAlternatives: unknown[];
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

export interface MacrofactorConciseRow {
  date: string;
  time: string;
  name: string;
  serving: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
}

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
      .scriptName("macrofactor")
      .strict()
      .option("source", {
        alias: ["s"],
        type: "string",
        default: defaultSourcePath,
        describe: "Path to MacroFactor historyFood.json",
      })
      .option("days", {
        alias: ["d"],
        type: "number",
        default: 7,
        describe: "Lookback window in days when --start is not set",
      })
      .option("start", {
        type: "string",
        describe: "Start date/time in ISO format (e.g. 2026-02-01 or 2026-02-01T00:00:00Z)",
      })
      .option("end", {
        type: "string",
        describe: "End date/time in ISO format",
      })
      .option("limit", {
        alias: ["l"],
        type: "number",
        describe: "Maximum number of foods to return",
      })
      .option("format", {
        alias: ["f"],
        type: "string",
        choices: OUTPUT_FORMATS,
        default: "table",
        describe: "Output format",
      })
      .option("output", {
        alias: ["o"],
        type: "string",
        describe: "Write output to this file path",
      })
      .option("pretty", {
        type: "boolean",
        default: true,
        describe: "Pretty-print JSON output",
      })
      .option("app", {
        type: "boolean",
        default: true,
        describe: "Open MacroFactor and refresh cache before export when local sync is stale",
      })
      .help()
      .parseAsync();

    if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
      throw new Error("--limit must be a positive number.");
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

    const jsonText = readFileSync(sourcePath, "utf8");
    const report = buildMacrofactorReport({
      sourcePath,
      jsonText,
      days: args.days,
      start: args.start,
      end: args.end,
      limit: args.limit,
    });
    const format = parseFormat(args.format);

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
    throw new Error("HOME is not set.");
  }
  return path.join(home, "Library", "Group Containers", "group.com.sbs.diet.widgetgroup", "historyFood.json");
}

function parseFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new Error(`Invalid format: ${value}`);
}

async function syncFromMacrofactorAppIfNeeded(options: { sourcePath: string }): Promise<void> {
  const sourceExists = existsSync(options.sourcePath);
  const nowMilliseconds = Date.now();
  const lastFileSyncMilliseconds = sourceExists ? getFileModifiedMilliseconds(options.sourcePath) : null;
  const runningAppAgeSeconds = getRunningAppAgeSeconds(APP_NAME);
  const lastAppLaunchMilliseconds =
    runningAppAgeSeconds != null ? nowMilliseconds - runningAppAgeSeconds * 1000 : null;
  const lastSyncMilliseconds = maxFinite(lastFileSyncMilliseconds, lastAppLaunchMilliseconds);
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

  if (runningAppAgeSeconds != null) {
    console.error(chalk.yellow(`${APP_NAME} is already running. Waiting briefly for it to sync...`));
    await sleep(APP_SYNC_WAIT_MILLISECONDS);
    return;
  }

  console.error(chalk.yellow(`Opening the ${APP_NAME} app to sync...`));
  runCommandOrThrow("open", ["-a", APP_NAME], `Failed to open ${APP_NAME}.`);
  await sleep(APP_SYNC_WAIT_MILLISECONDS);
  runCommandOrThrow("osascript", ["-e", `tell application "${APP_NAME}" to quit`], `Failed to quit ${APP_NAME}.`);
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

function getRunningAppAgeSeconds(appName: string): number | null {
  const pidResult = spawnSync("pgrep", ["-x", appName], { encoding: "utf8" });
  if (pidResult.status !== 0) {
    return null;
  }
  const pid = `${pidResult.stdout ?? ""}`.trim().split(/\s+/)[0];
  if (!pid) {
    return null;
  }
  const elapsedResult = spawnSync("ps", ["-o", "etimes=", "-p", pid], { encoding: "utf8" });
  if (elapsedResult.status !== 0) {
    return null;
  }
  const elapsedSeconds = Number(`${elapsedResult.stdout ?? ""}`.trim());
  return Number.isFinite(elapsedSeconds) ? elapsedSeconds : null;
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
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }
  const stderr = `${result.stderr ?? ""}`.trim();
  const stdout = `${result.stdout ?? ""}`.trim();
  const details = stderr || stdout;
  throw new Error(details ? `${errorPrefix} ${details}` : errorPrefix);
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function renderOutput(options: {
  report: MacrofactorReport;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
}): void {
  if (options.format === "table") {
    if (options.outputPath) {
      throw new Error("--output is not supported with --format=table. Use --format=csv or --format=json.");
    }
    console.table(toConciseRows(options.report, { dateFormat: "table" }));
    return;
  }

  const text =
    options.format === "json"
      ? `${JSON.stringify(options.report, null, options.pretty ? 2 : 0)}\n`
      : renderCsv(toConciseRows(options.report, { dateFormat: "csv" }));

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, "utf8");
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
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

type ConciseDateFormat = "iso" | "table" | "csv";

export function toConciseRows(
  report: MacrofactorReport,
  options?: { dateFormat?: ConciseDateFormat }
): MacrofactorConciseRow[] {
  const dateFormat = options?.dateFormat ?? "iso";
  const rows = report.foods.map(food => {
    const parts = getDateTimeParts(food.latestConsumedAt, dateFormat);
    const serving = formatServing(food.servingUserSelection) || formatServing(food.servingDefault);
    return {
      timestamp: Date.parse(food.latestConsumedAt),
      row: {
        date: parts.date,
        time: parts.time.split(':').slice(0, 2).join(':'),
        name: food.title,
        serving,
        calories: roundNullable(food.nutrition.caloriesKcal, 0),
        protein: roundNullable(food.nutrition.proteinG, 2),
        carbs: roundNullable(food.nutrition.carbsG, 2),
        fat: roundNullable(food.nutrition.fatG, 2),
        fiber: roundNullable(food.nutrition.fiberG, 2),
      } satisfies MacrofactorConciseRow,
    };
  });
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows.map(row => row.row);
}

export function renderCsv(rows: MacrofactorConciseRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map(row => {
    return CSV_COLUMNS.map(column => escapeCsvValue(row[column])).join(",");
  });
  return `${[header, ...lines].join("\n")}\n`;
}

function parseHistoryJson(jsonText: string): HistoryFile {
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object" || !("food" in parsed)) {
    throw new Error("Invalid MacroFactor history file: missing top-level `food`.");
  }
  const food = (parsed as { food?: unknown }).food;
  if (!food || typeof food !== "object" || Array.isArray(food)) {
    throw new Error("Invalid MacroFactor history file: `food` must be an object.");
  }
  return parsed as HistoryFile;
}

function resolveWindow(options: {
  days: number;
  start?: string;
  end?: string;
  nowUnixSeconds?: number;
}): { startUnixSeconds: number; endUnixSeconds: number } {
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error("--days must be a positive number.");
  }

  const nowUnixSeconds = options.nowUnixSeconds ?? Date.now() / 1000;
  const endUnixSeconds = options.end ? parseDateArg(options.end, "end") : nowUnixSeconds;
  const startUnixSeconds = options.start
    ? parseDateArg(options.start, "start")
    : endUnixSeconds - options.days * SECONDS_PER_DAY;

  if (startUnixSeconds > endUnixSeconds) {
    throw new Error("Start date must be before end date.");
  }

  return { startUnixSeconds, endUnixSeconds };
}

function parseDateArg(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return timestamp / 1000;
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
  const title = toStringOrNull(food.title) ?? toStringOrNull(food.brandName) ?? "(untitled)";
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
    itemId: toStringOrNull(entry.itemId) ?? "(missing-item-id)",
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

function getDateTimeParts(value: string, dateFormat: ConciseDateFormat): { date: string; time: string } {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return { date: "", time: "" };
  }
  const date = formatDate(timestamp, dateFormat);
  const iso = new Date(timestamp).toISOString();
  return {
    date,
    time: iso.slice(11, 19),
  };
}

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function formatDate(timestamp: number, format: ConciseDateFormat): string {
  const d = new Date(timestamp);
  if (format === "iso") {
    return d.toISOString().slice(0, 10);
  }
  if (format === "csv") {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getUTCFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }
  const weekday = WEEKDAYS_SHORT[d.getUTCDay()] ?? "";
  const month = MONTHS_LONG[d.getUTCMonth()] ?? "";
  const day = formatOrdinal(d.getUTCDate());
  return `${weekday} ${month} ${day}`.trim();
}

function formatOrdinal(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  const abs = Math.abs(Math.trunc(value));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${abs}th`;
  }
  const mod10 = abs % 10;
  const suffix = mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
  return `${abs}${suffix}`;
}

function roundNullable(value: number | null, fractionDigits: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** fractionDigits;
  return Math.round((value as number) * factor) / factor;
}

function formatServing(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const maybeServing = value as { quantity?: unknown; name?: unknown };
  const quantity = toFiniteNumber(maybeServing.quantity);
  const name = toStringOrNull(maybeServing.name);

  if (quantity != null && name) {
    return `${formatQuantity(quantity)} ${name}`;
  }
  if (name) {
    return name;
  }
  if (quantity != null) {
    return formatQuantity(quantity);
  }
  return "";
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Number(value.toFixed(3)).toString();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function escapeCsvValue(value: string | number | null): string {
  if (value == null) {
    return "";
  }
  const stringValue = String(value);
  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replaceAll('"', '""')}"`;
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
  return typeof value === "string" && value.trim() ? value : null;
}

function appleToUnixSeconds(secondsSince2001: number): number {
  return secondsSince2001 + APPLE_REFERENCE_UNIX_SECONDS;
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

const CODE_NAME_MAP: Record<string, string> = {
  a: "alcohol_g",
  c: "carbs_g",
  e: "fiber_g",
  f: "fat_g",
  k: "calories_kcal",
  nc: "net_carbs_g",
  p: "protein_g",
  s: "sugars_g",
  ea: "added_sugars_g",
};
