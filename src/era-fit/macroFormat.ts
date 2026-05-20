import chalk from 'chalk';

import { padVisibleStart, visibleLength } from '../utils/tabular';
import { formatNumber, roundNumber, type EraFitMacroTotals } from './core';

export interface MacroColumnWidths {
  calories: number;
  protein: number;
  netCarbs: number;
  fat: number;
}

export function formatMacros(value: EraFitMacroTotals): string {
  return formatMacroColumns(value, getMacroColumnWidths([value]));
}

export function formatMacroColumns(value: EraFitMacroTotals, widths: MacroColumnWidths): string {
  return [
    chalk.blue(formatCaloriesMacro(value, widths.calories)),
    chalk.gray('|'),
    chalk.red(formatProteinMacro(value, widths.protein)),
    chalk.gray('|'),
    chalk.yellow(formatCarbsMacro(value, widths.netCarbs)),
    chalk.gray('|'),
    chalk.cyan(formatFatMacro(value, widths.fat)),
  ].join(' ');
}

export function getMacroColumnWidths(values: EraFitMacroTotals[]): MacroColumnWidths {
  return values.reduce<MacroColumnWidths>((widths, value) => ({
    calories: Math.max(widths.calories, visibleLength(formatNullableNumber(value.calories))),
    protein: Math.max(widths.protein, visibleLength(formatNullableNumber(value.protein))),
    netCarbs: Math.max(widths.netCarbs, visibleLength(formatNullableNumber(value.net_carbs))),
    fat: Math.max(widths.fat, visibleLength(formatNullableNumber(value.fat))),
  }), {
    calories: 3,
    protein: 2,
    netCarbs: 2,
    fat: 2,
  });
}

function formatCaloriesMacro(value: EraFitMacroTotals, width: number): string {
  return `${padVisibleStart(formatNullableNumber(value.calories), width)} kcal`;
}

function formatProteinMacro(value: EraFitMacroTotals, width: number): string {
  return `P ${padVisibleStart(formatNullableNumber(value.protein), width)}`;
}

function formatCarbsMacro(value: EraFitMacroTotals, width: number): string {
  return `C ${padVisibleStart(formatNullableNumber(value.net_carbs), width)}`;
}

function formatFatMacro(value: EraFitMacroTotals, width: number): string {
  return `F ${padVisibleStart(formatNullableNumber(value.fat), width)}`;
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '-' : formatNumber(roundNumber(value));
}
