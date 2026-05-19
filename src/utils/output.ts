import type { Argv } from 'yargs';

export const OUTPUT_FORMATS = ['json', 'table', 'csv', 'csv:full'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type CsvValue = string | number | null;
type ValueFormatter = (value: unknown) => unknown;

export interface OutputCliArgs {
  format: string;
  output?: string;
}

export function addOutputOptions<T>(parser: Argv<T>, choices: readonly string[]): Argv<T & OutputCliArgs> {
  return parser
    .option('format', {
      alias: ['f'],
      type: 'string',
      choices,
      default: 'table',
      describe: 'Output format',
    })
    .option('output', {
      alias: ['o'],
      type: 'string',
      describe: 'Write output to this file path',
    }) as unknown as Argv<T & OutputCliArgs>;
}

export function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new Error(`Invalid format: ${value}`);
}

export function renderCsvRecords(
  rows: Record<string, CsvValue>[],
  columns: readonly string[],
  options?: { valueFormatters?: Record<string, ValueFormatter> }
): string {
  const header = columns.join(',');
  const lines = rows.map(row =>
    columns.map(column => escapeCsvValue(normalizeCsvValue(row[column] ?? null, column, options?.valueFormatters))).join(',')
  );
  return `${[header, ...lines].join('\n')}\n`;
}

export function renderTableRecords(
  rows: object[],
  options?: { valueFormatters?: Record<string, ValueFormatter> }
): void {
  console.table(rows.map(row => normalizeTableRow(row as Record<string, unknown>, options?.valueFormatters)));
}

export function formatDisplayNumber(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const numeric = value as number;
  const abs = Math.abs(numeric);
  if (abs >= 10) {
    return Math.round(numeric);
  }
  if (abs >= 1) {
    return Math.round(numeric * 10) / 10;
  }
  return Math.round(numeric * 100) / 100;
}

function normalizeTableRow(
  row: Record<string, unknown>,
  valueFormatters?: Record<string, ValueFormatter>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeOutputValue(value, key, valueFormatters)]));
}

function normalizeCsvValue(
  value: CsvValue,
  key?: string,
  valueFormatters?: Record<string, ValueFormatter>
): CsvValue {
  const normalized = normalizeOutputValue(value, key, valueFormatters);
  return (normalized ?? null) as CsvValue;
}

function normalizeOutputValue(
  value: unknown,
  key?: string,
  valueFormatters?: Record<string, ValueFormatter>
): unknown {
  const formatter = key ? valueFormatters?.[key] : undefined;
  if (formatter) {
    return formatter(value);
  }
  if (typeof value === 'number') {
    return formatDisplayNumber(value);
  }
  if (typeof value === 'string') {
    return value.replaceAll(/\s*\n\s*/g, '; ');
  }
  return value;
}

function escapeCsvValue(value: CsvValue): string {
  if (value == null) {
    return '';
  }
  const stringValue = String(value);
  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replaceAll('"', '""')}"`;
}
