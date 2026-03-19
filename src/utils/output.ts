export const OUTPUT_FORMATS = ['json', 'table', 'csv', 'csv:full'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type CsvValue = string | number | null;

export function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  throw new Error(`Invalid format: ${value}`);
}

export function renderCsvRecords(rows: Record<string, CsvValue>[], columns: readonly string[]): string {
  const header = columns.join(',');
  const lines = rows.map(row => columns.map(column => escapeCsvValue(row[column] ?? null)).join(','));
  return `${[header, ...lines].join('\n')}\n`;
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
