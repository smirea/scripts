export type TabularCell = string | number | null | undefined;

export interface TabularColumn {
  align?: 'left' | 'right';
  maxWidth?: number;
  minWidth?: number;
  width?: number;
}

export interface FormatTabularRowsOptions {
  columns?: readonly TabularColumn[];
  gap?: string;
}

const ESCAPE = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ESCAPE}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, '');
}

export function visibleLength(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

export function padVisibleEnd(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : `${value}${' '.repeat(width - length)}`;
}

export function padVisibleStart(value: string, width: number): string {
  const length = visibleLength(value);
  return length >= width ? value : `${' '.repeat(width - length)}${value}`;
}

export function truncateVisibleEnd(value: string, width: number): string {
  if (width <= 0 || visibleLength(value) <= width) {
    return value;
  }
  if (width <= 3) {
    return '.'.repeat(width);
  }
  return `${Array.from(stripAnsi(value)).slice(0, width - 3).join('')}...`;
}

export function formatTabularRows(
  rows: readonly (readonly TabularCell[])[],
  options: FormatTabularRowsOptions = {}
): string[] {
  const formattedRows = rows.map(row => row.map((value, index) => {
    const cell = formatCellValue(value);
    const maxWidth = options.columns?.[index]?.maxWidth;
    return maxWidth == null ? cell : truncateVisibleEnd(cell, maxWidth);
  }));
  const columnCount = formattedRows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: columnCount }, (_, index) => {
    const fixedWidth = options.columns?.[index]?.width;
    if (fixedWidth != null) {
      return fixedWidth;
    }
    const minWidth = options.columns?.[index]?.minWidth ?? 0;
    return formattedRows.reduce((max, row) => Math.max(max, visibleLength(row[index] ?? '')), minWidth);
  });
  const gap = options.gap ?? '  ';

  return formattedRows.map(row => Array.from({ length: columnCount }, (_, index) => {
    const cell = row[index] ?? '';
    const column = options.columns?.[index];
    if (index === columnCount - 1 && column?.width == null) {
      return cell;
    }
    return column?.align === 'right'
      ? padVisibleStart(cell, widths[index])
      : padVisibleEnd(cell, widths[index]);
  }).join(gap).trimEnd());
}

export function formatTabularRow(
  cells: readonly TabularCell[],
  options: FormatTabularRowsOptions = {}
): string {
  return formatTabularRows([cells], options)[0] ?? '';
}

function formatCellValue(value: TabularCell): string {
  return value == null ? '' : String(value);
}
