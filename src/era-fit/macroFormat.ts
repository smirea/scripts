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
  return [
    chalk.blue(formatCaloriesMacro(value)),
    chalk.red(formatProteinMacro(value)),
    chalk.yellow(formatCarbsMacro(value)),
    chalk.magenta(formatFatMacro(value)),
  ].join(chalk.gray(' | '));
}

export function formatMacroColumns(value: EraFitMacroTotals, widths: MacroColumnWidths): string {
  return [
    padVisibleStart(chalk.blue(formatCaloriesMacro(value)), widths.calories),
    chalk.gray('|'),
    padVisibleStart(chalk.red(formatProteinMacro(value)), widths.protein),
    chalk.gray('|'),
    padVisibleStart(chalk.yellow(formatCarbsMacro(value)), widths.netCarbs),
    chalk.gray('|'),
    padVisibleStart(chalk.magenta(formatFatMacro(value)), widths.fat),
  ].join(' ');
}

export function getMacroColumnWidths(values: EraFitMacroTotals[]): MacroColumnWidths {
  return values.reduce<MacroColumnWidths>((widths, value) => ({
    calories: Math.max(widths.calories, visibleLength(formatCaloriesMacro(value))),
    protein: Math.max(widths.protein, visibleLength(formatProteinMacro(value))),
    netCarbs: Math.max(widths.netCarbs, visibleLength(formatCarbsMacro(value))),
    fat: Math.max(widths.fat, visibleLength(formatFatMacro(value))),
  }), {
    calories: visibleLength(formatCaloriesMacro(emptyMacros)),
    protein: visibleLength(formatProteinMacro(emptyMacros)),
    netCarbs: visibleLength(formatCarbsMacro(emptyMacros)),
    fat: visibleLength(formatFatMacro(emptyMacros)),
  });
}

const emptyMacros = { calories: null, protein: null, net_carbs: null, fat: null } satisfies EraFitMacroTotals;

function formatCaloriesMacro(value: EraFitMacroTotals): string {
  return `${formatNullableNumber(value.calories)} kcal`;
}

function formatProteinMacro(value: EraFitMacroTotals): string {
  return `P ${formatNullableNumber(value.protein)}g`;
}

function formatCarbsMacro(value: EraFitMacroTotals): string {
  return `NC ${formatNullableNumber(value.net_carbs)}g`;
}

function formatFatMacro(value: EraFitMacroTotals): string {
  return `F ${formatNullableNumber(value.fat)}g`;
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '-' : formatNumber(roundNumber(value));
}
