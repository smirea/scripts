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
const FULL_BASE_COLUMNS = ['date', 'time', 'name', 'serving'] as const;
export const OUTPUT_FORMATS = ['json', 'table', 'csv'] as const;
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

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type CsvValue = string | number | null;

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
  full?: boolean;
}): void {
  const full = options.full ?? false;
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    console.table(full ? toFullRows(options.report, { dateFormat: 'table' }).rows : toConciseRows(options.report, { dateFormat: 'table' }));
    return;
  }

  const text = (() => {
    if (options.format === 'json') {
      return `${JSON.stringify(serializeReport(options.report, { full }), null, options.pretty ? 2 : 0)}\n`;
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
  options?: { full?: boolean }
): Record<string, unknown> {
  const includeServingAlternatives = options?.full ?? false;
  return {
    ...report,
    foods: report.foods.map(food => ({
      itemId: food.itemId,
      title: food.title,
      brandName: food.brandName,
      source: food.source,
      isCustom: food.isCustom,
      firstConsumedAt: food.firstConsumedAt,
      latestConsumedAt: food.latestConsumedAt,
      recipeCount: food.recipeCount,
      recipe: food.recipe,
      servingDefault: food.servingDefault,
      servingUserSelection: food.servingUserSelection,
      ...(includeServingAlternatives ? { servingAlternatives: food.servingAlternatives } : {}),
      nutrition: flattenNamedNutrients(food.nutrition),
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
        serving: formatServing(food.servingUserSelection) || formatServing(food.servingDefault),
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

export function renderCsvRecords(rows: Record<string, CsvValue>[], columns: string[]): string {
  const header = columns.join(',');
  const lines = rows.map(row => columns.map(column => escapeCsvValue(row[column] ?? null)).join(','));
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

function setNamedNutrient(target: Record<string, number>, name: string, value: number | null | undefined): void {
  if (target[name] != null || !Number.isFinite(value)) {
    return;
  }
  target[name] = roundNamedNutrient(value as number);
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

function roundNamedNutrient(value: number): number {
  const abs = Math.abs(value);
  if (abs < 10) {
    return Math.round(value * 10) / 10;
  }
  return Math.round(value);
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
