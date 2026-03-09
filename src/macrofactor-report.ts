import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const APPLE_REFERENCE_UNIX_SECONDS = 978307200;
const SECONDS_PER_DAY = 24 * 60 * 60;
const CSV_COLUMNS = [
  'date',
  'time',
  'name',
  'serving',
  'calories',
  'protein',
  'carbs',
  'fat',
  'fiber',
] as const;
export const OUTPUT_FORMATS = ['json', 'table', 'csv'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

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

export interface ResolvedWindow {
  startUnixSeconds: number;
  endUnixSeconds: number;
}

type ConciseDateFormat = 'iso' | 'table' | 'csv';

export function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new Error(`Invalid format: ${value}`);
}

export function renderOutput(options: {
  report: MacrofactorReport;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
}): void {
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    console.table(toConciseRows(options.report, { dateFormat: 'table' }));
    return;
  }

  const text =
    options.format === 'json'
      ? `${JSON.stringify(options.report, null, options.pretty ? 2 : 0)}\n`
      : renderCsv(toConciseRows(options.report, { dateFormat: 'csv' }));

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
}

export function toConciseRows(
  report: MacrofactorReport,
  options?: { dateFormat?: ConciseDateFormat }
): MacrofactorConciseRow[] {
  const dateFormat = options?.dateFormat ?? 'iso';
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
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map(row => CSV_COLUMNS.map(column => escapeCsvValue(row[column])).join(','));
  return `${[header, ...lines].join('\n')}\n`;
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

function roundNullable(value: number | null, fractionDigits: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** fractionDigits;
  return Math.round((value as number) * factor) / factor;
}

function formatServing(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
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
  return '';
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Number(value.toFixed(3)).toString();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function escapeCsvValue(value: string | number | null): string {
  if (value == null) {
    return '';
  }
  const stringValue = String(value);
  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replaceAll('"', '""')}"`;
}
