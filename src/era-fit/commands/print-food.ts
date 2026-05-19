import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CommandModule } from 'yargs';
import type { Argv, ArgumentsCamelCase } from 'yargs';

import {
  fetchEraFitReport,
  resolveDateWindow,
  resolveSession,
  type EraFitReport,
} from '../core';
import {
  OUTPUT_FORMATS,
  addOutputOptions,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputCliArgs,
  type OutputFormat,
} from '../../utils/output';

const DEFAULT_DAYS = 1;
const DAILY_COLUMNS = [
  'date',
  'template',
  'status',
  'calories',
  'goal_calories',
  'protein',
  'goal_protein',
  'net_carbs',
  'goal_net_carbs',
  'fat',
  'goal_fat',
  'foods_logged',
] as const;
const FOOD_COLUMNS = [
  'date',
  'time',
  'meal',
  'kind',
  'name',
  'brand',
  'serving',
  'calories',
  'protein',
  'net_carbs',
  'fat',
] as const;
const RECIPE_COLUMNS = [
  'date',
  'time',
  'meal',
  'recipe',
  'recipe_serving',
  'ingredient',
  'brand',
  'serving',
  'calories',
  'protein',
  'net_carbs',
  'fat',
] as const;
const TEMPLATE_COLUMNS = [
  'id',
  'title',
  'type',
  'unit',
  'body_composition_goal',
  'calories',
  'protein',
  'net_carbs',
  'fat',
  'protein_setting',
  'net_carbs_setting',
  'fat_setting',
] as const;

interface PrintFoodCliArgs extends OutputCliArgs {
  date?: string;
  days: number;
  start?: string;
  end?: string;
  limit?: number;
}

function addPrintFoodOptions<T>(parser: Argv<T>): Argv<T & PrintFoodCliArgs> {
  return addOutputOptions(parser, OUTPUT_FORMATS)
    .option('date', {
      type: 'string',
      describe: 'Local date to report, in YYYY-MM-DD format. Defaults to today when --start is not set',
    })
    .option('days', {
      alias: ['d'],
      type: 'number',
      default: DEFAULT_DAYS,
      describe: 'Lookback window in days when --start is not set',
    })
    .option('start', {
      type: 'string',
      describe: 'Start date in YYYY-MM-DD format',
    })
    .option('end', {
      type: 'string',
      describe: 'End date in YYYY-MM-DD format',
    })
    .option('limit', {
      alias: ['l'],
      type: 'number',
      describe: 'Maximum number of logged foods to return',
    }) as Argv<T & PrintFoodCliArgs>;
}

async function runPrintFoodCommand(args: ArgumentsCamelCase<PrintFoodCliArgs>): Promise<void> {
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number.');
  }

  const format = parseOutputFormat(args.format);
  const session = await resolveSession();
  const window = resolveDateWindow({
    days: args.days,
    date: args.date,
    start: args.start,
    end: args.end,
  });
  const report = await fetchEraFitReport(session, {
    window,
    limit: args.limit,
  });

  renderOutput({
    report,
    format,
    outputPath: args.output,
  });
}

function renderOutput(options: {
  report: EraFitReport;
  format: OutputFormat;
  outputPath?: string;
}): void {
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    renderTable(options.report);
    return;
  }

  const text = (() => {
    if (options.format === 'json') {
      return `${JSON.stringify(options.report, null, 2)}\n`;
    }
    if (options.format === 'csv:full') {
      return renderFullCsv(options.report);
    }
    return renderCsvRecords(toDailyCsvRows(options.report), DAILY_COLUMNS);
  })();

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }
  process.stdout.write(text);
}

function renderTable(report: EraFitReport): void {
  process.stdout.write('Daily Macro Overview\n');
  renderTableRecords(toDailyCsvRows(report));
  if (report.foods.length > 0) {
    process.stdout.write('\nLogged Foods\n');
    renderTableRecords(toFoodCsvRows(report));
  }
  if (report.recipes.length > 0) {
    process.stdout.write('\nRecipes\n');
    renderTableRecords(toRecipeCsvRows(report));
  }
  if (report.templates.length > 0) {
    process.stdout.write('\nMacro Templates\n');
    renderTableRecords(toTemplateCsvRows(report));
  }
}

function renderFullCsv(report: EraFitReport): string {
  return [
    {
      name: 'daily_overview',
      csv: renderCsvRecords(toDailyCsvRows(report), DAILY_COLUMNS),
    },
    {
      name: 'logged_foods',
      csv: renderCsvRecords(toFoodCsvRows(report), FOOD_COLUMNS),
    },
    {
      name: 'recipes',
      csv: renderCsvRecords(toRecipeCsvRows(report), RECIPE_COLUMNS),
    },
    {
      name: 'macro_templates',
      csv: renderCsvRecords(toTemplateCsvRows(report), TEMPLATE_COLUMNS),
    },
  ].map(section => `\n==== ${section.name} ===\n${section.csv}`).join('');
}

function toDailyCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.dailyOverview.map(row => ({
    date: row.date,
    template: row.template,
    status: row.status,
    calories: row.calories,
    goal_calories: row.goal_calories,
    protein: row.protein,
    goal_protein: row.goal_protein,
    net_carbs: row.net_carbs,
    goal_net_carbs: row.goal_net_carbs,
    fat: row.fat,
    goal_fat: row.goal_fat,
    foods_logged: row.foods_logged,
  }));
}

function toFoodCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.foods.map(food => ({
    date: food.date,
    time: food.time,
    meal: food.meal,
    kind: food.kind,
    name: food.name,
    brand: food.brand,
    serving: food.serving,
    calories: food.calories,
    protein: food.protein,
    net_carbs: food.net_carbs,
    fat: food.fat,
  }));
}

function toRecipeCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.recipes.map(recipe => ({
    date: recipe.date,
    time: recipe.time,
    meal: recipe.meal,
    recipe: recipe.recipe,
    recipe_serving: recipe.recipe_serving,
    ingredient: recipe.ingredient,
    brand: recipe.brand,
    serving: recipe.serving,
    calories: recipe.calories,
    protein: recipe.protein,
    net_carbs: recipe.net_carbs,
    fat: recipe.fat,
  }));
}

function toTemplateCsvRows(report: EraFitReport): Record<string, CsvValue>[] {
  return report.templates.map(template => ({
    id: template.id,
    title: template.title,
    type: template.type,
    unit: template.unit,
    body_composition_goal: template.body_composition_goal,
    calories: template.calories,
    protein: template.protein,
    net_carbs: template.net_carbs,
    fat: template.fat,
    protein_setting: template.protein_setting,
    net_carbs_setting: template.net_carbs_setting,
    fat_setting: template.fat_setting,
  }));
}

export const printFoodCommand = {
  command: 'print-food',
  describe: 'Print daily macro log',
  builder: addPrintFoodOptions,
  handler: runPrintFoodCommand,
} satisfies CommandModule<{}, PrintFoodCliArgs>;
