import { writeFileSync } from 'node:fs';
import path from 'node:path';

import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import type { Argv, ArgumentsCamelCase } from 'yargs';

import { createShoppingList } from '../../anylist';
import env from '../../env';
import { parseOutputFormat, type OutputFormat } from '../../utils/output';
import { formatTabularRows, padVisibleEnd, visibleLength } from '../../utils/tabular';
import { loadEraFitCache } from '../cache';
import {
  canonicalShoppingUnit,
  fetchEraFitMealPlan,
  formatLongDate,
  formatNumber,
  parseNumberLike,
  parseQuantity,
  resolveSession,
  roundNumber,
  shoppingUnitPriority,
  uniqueStrings,
  WEEKDAY_NAMES,
  type EraFitMacroTotals,
  type EraFitMealPlanDay,
  type EraFitMealPlanFoodItem,
  type EraFitMealPlanReport,
  type EraFitShoppingListItem,
  type ShoppingMeasure,
} from '../core';
import { runInteractiveTodayMealPlan } from '../mealplanInteractive';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const MEALPLAN_CATEGORY_MODEL = 'gemini-2.5-flash';
const MEAL_PLAN_OUTPUT_FORMATS = ['json', 'table'] as const;
const MEALPLAN_ANYLIST_CATEGORIES = [
  'bakery',
  'beverages',
  'breakfast-and-cereal',
  'condiments-oils-and-salad-dressings',
  'cooking-and-baking',
  'dairy',
  'frozen-foods',
  'grains-pasta-and-side-dishes',
  'meat',
  'produce',
  'seafood',
  'snacks-cookies-and-candy',
  'soups-and-canned-goods',
  'other',
] as const;

type MealPlanAnyListCategory = (typeof MEALPLAN_ANYLIST_CATEGORIES)[number];

interface OutputCliArgs {
  format: string;
  output?: string;
}

interface MealPlanCliArgs extends OutputCliArgs {
  anylist: boolean;
  today: boolean;
  dryRun: boolean;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

interface MealItemLabel {
  styled: string;
}

interface MealItemServing {
  text: string;
  measure: ShoppingMeasure;
}

export const mealPlanCommand = {
  command: ['mealplan', 'meaplan'],
  describe: 'Print the weekly suggested meal plan and aggregate shopping list',
  builder: addMealPlanOptions,
  handler: runMealPlanCommand,
} satisfies CommandModule<{}, MealPlanCliArgs>;

function addMealPlanOptions<T>(parser: Argv<T>): Argv<T & MealPlanCliArgs> {
  return addOutputOptions(parser, MEAL_PLAN_OUTPUT_FORMATS)
    .option('anylist', {
      type: 'boolean',
      default: false,
      describe: 'Create an AnyList shopping list from the suggested mealplan ingredients',
    })
    .option('today', {
      alias: ['t'],
      type: 'boolean',
      default: false,
      describe: 'Open today\'s suggested meal plan checklist. Use --format=json for noninteractive output',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'In interactive --today mode, resolve foods without writing to Era Fit or updating the cache',
    }) as unknown as Argv<T & MealPlanCliArgs>;
}

function addOutputOptions<T>(parser: Argv<T>, choices: readonly string[]): Argv<T & OutputCliArgs> {
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

async function runMealPlanCommand(args: ArgumentsCamelCase<MealPlanCliArgs>): Promise<void> {
  const format = parseOutputFormat(args.format);
  if (args.today && args.anylist) {
    throw new Error('--today cannot be combined with --anylist.');
  }
  if (args.dryRun && !args.today) {
    throw new Error('--dry-run only applies to interactive --today mode.');
  }

  const session = await resolveSession();
  const mealPlan = await fetchEraFitMealPlan(session);
  if (args.today && format === 'table' && !args.output) {
    await runInteractiveTodayMealPlan({
      session,
      cache: loadEraFitCache(),
      day: getTodayMealPlanDay(mealPlan),
      dryRun: args.dryRun,
    });
    return;
  }
  const anyListResult = args.anylist ? await createAnyListMealPlan(mealPlan) : null;
  renderMealPlanOutput({
    report: mealPlan,
    format,
    outputPath: args.output,
    anyListResult,
    todayOnly: args.today,
  });
}

async function createAnyListMealPlan(report: EraFitMealPlanReport): Promise<{ id: string; name: string; added: number }> {
  const name = `Mealplan ${formatLongDate(new Date())}`;
  const categories = await categorizeMealPlanShoppingList(report.shoppingList);
  const list = await createShoppingList(name, report.shoppingList.map(item => ({
    name: item.name,
    serving: item.quantity,
    description: formatAnyListMealPlanDescription(item),
    categoryMatchId: categories.get(item.name) ?? 'other',
  })), { replaceExisting: true });
  return {
    id: list.id,
    name: list.name,
    added: list.added.length,
  };
}

function formatAnyListMealPlanDescription(item: EraFitShoppingListItem): string | undefined {
  const parts = [
    item.meals > 1 ? `${item.meals} meals` : null,
    ...item.variations,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

async function categorizeMealPlanShoppingList(items: EraFitShoppingListItem[]): Promise<Map<string, MealPlanAnyListCategory>> {
  const fallback = new Map(items.map(item => [item.name, inferMealPlanCategory(item.name)]));
  try {
    const geminiCategories = await categorizeMealPlanShoppingListWithGemini(items);
    for (const item of items) {
      const category = geminiCategories.get(item.name);
      if (category && isMealPlanAnyListCategory(category)) {
        fallback.set(item.name, category);
      }
    }
  } catch (error) {
    console.warn(`Gemini categorization failed, using local category rules: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fallback;
}

async function categorizeMealPlanShoppingListWithGemini(items: EraFitShoppingListItem[]): Promise<Map<string, string>> {
  const response = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${MEALPLAN_CATEGORY_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: [
            'Categorize these meal-plan shopping list ingredients into AnyList grocery category IDs.',
            'Return only JSON with this shape: {"items":[{"name":"exact input name","categoryMatchId":"one allowed category"}]}.',
            `Allowed categories: ${MEALPLAN_ANYLIST_CATEGORIES.join(', ')}`,
            JSON.stringify(items.map(item => ({
              name: item.name,
              quantity: item.quantity,
              servings: item.servings.slice(0, 6),
            }))),
          ].join('\n'),
        }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  const payload = await response.json() as GeminiGenerateContentResponse;
  const text = payload.candidates
    ?.flatMap(candidate => candidate.content?.parts ?? [])
    .map(part => part.text ?? '')
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('model returned no category JSON');
  }

  const parsed = JSON.parse(stripJsonCodeFence(text)) as { items?: Array<{ name?: string; categoryMatchId?: string }> };
  return new Map((parsed.items ?? [])
    .filter(item => typeof item.name === 'string' && typeof item.categoryMatchId === 'string')
    .map(item => [item.name as string, item.categoryMatchId as string]));
}

function stripJsonCodeFence(value: string): string {
  return value
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function isMealPlanAnyListCategory(value: string): value is MealPlanAnyListCategory {
  return (MEALPLAN_ANYLIST_CATEGORIES as readonly string[]).includes(value);
}

function inferMealPlanCategory(name: string): MealPlanAnyListCategory {
  const normalized = name.toLowerCase();
  if (/\b(chicken|turkey|beef|steak|pork|bacon|sausage)\b/.test(normalized)) return 'meat';
  if (/\b(salmon|tuna|cod|tilapia|shrimp|seafood)\b/.test(normalized)) return 'seafood';
  if (/\b(yogurt|milk|cheese|cottage|kefir|egg|eggs|egg white|whey)\b/.test(normalized)) return 'dairy';
  if (/\b(bread|bagel|tortilla|pita|bun|roll)\b/.test(normalized)) return 'bakery';
  if (/\b(oat|oatmeal|cereal|granola)\b/.test(normalized)) return 'breakfast-and-cereal';
  if (/\b(rice|pasta|quinoa|potato|sweet potato|beans|lentils)\b/.test(normalized)) return 'grains-pasta-and-side-dishes';
  if (/\b(oil|olive|avocado oil|dressing|mustard|mayo|sauce|vinegar|salsa)\b/.test(normalized)) return 'condiments-oils-and-salad-dressings';
  if (/\b(almond|walnut|cashew|chia|flax|seed|protein powder)\b/.test(normalized)) return 'snacks-cookies-and-candy';
  if (/\b(frozen)\b/.test(normalized)) return 'frozen-foods';
  if (/\b(broth|stock|canned|soup)\b/.test(normalized)) return 'soups-and-canned-goods';
  if (/\b(water|tea|coffee|juice|drink|beverage)\b/.test(normalized)) return 'beverages';
  if (/\b(flour|sugar|spice|powder|baking)\b/.test(normalized)) return 'cooking-and-baking';
  if (/\b(arugula|asparagus|avocado|banana|berries|blackberries|blueberries|broccoli|spinach|strawberries|zucchini|apple|orange|lemon|lime|lettuce|tomato|pepper|onion|carrot|fruit|vegetable)\b/.test(normalized)) return 'produce';
  return 'other';
}

function renderMealPlanOutput(options: {
  report: EraFitMealPlanReport;
  format: OutputFormat;
  outputPath?: string;
  anyListResult: { id: string; name: string; added: number } | null;
  todayOnly?: boolean;
}): void {
  if (options.format !== 'table' && options.format !== 'json') {
    throw new Error('The mealplan command supports --format=table or --format=json.');
  }
  const text = renderMealPlanOutputText(options);
  if (options.outputPath) {
    writeFileSync(path.resolve(options.outputPath), text, 'utf8');
    return;
  }
  process.stdout.write(text);
}

function renderMealPlanOutputText(options: {
  report: EraFitMealPlanReport;
  format: OutputFormat;
  anyListResult: { id: string; name: string; added: number } | null;
  todayOnly?: boolean;
}): string {
  if (options.todayOnly) {
    const day = getTodayMealPlanDay(options.report);
    return options.format === 'json'
      ? `${JSON.stringify(day, null, 2)}\n`
      : renderMealPlanDayText(day);
  }
  return options.format === 'json'
    ? `${JSON.stringify({ ...options.report, anyList: options.anyListResult }, null, 2)}\n`
    : renderMealPlanText(options.report, options.anyListResult);
}

function getTodayMealPlanDay(report: EraFitMealPlanReport): EraFitMealPlanDay {
  const today = WEEKDAY_NAMES[new Date().getDay()];
  const day = report.days.find(candidate => candidate.day === today);
  if (!day) {
    throw new Error(`Meal plan did not include today (${today}).`);
  }
  return day;
}

function renderMealPlanText(
  report: EraFitMealPlanReport,
  anyListResult: { id: string; name: string; added: number } | null = null
): string {
  const lines: string[] = [chalk.bold('Weekly Meal Plan'), ''];
  for (const day of report.days) {
    lines.push(...renderMealPlanDayLines(day), '');
  }
  lines.push(chalk.bold('Shopping List'));
  if (report.shoppingList.length === 0) {
    lines.push(chalk.gray('  No ingredients found.'));
  } else {
    const shoppingRows = formatTabularRows([
      [chalk.gray('item'), chalk.gray('qty'), chalk.gray('meals'), chalk.gray('servings')],
      ...report.shoppingList.map(item => [
        item.name,
        chalk.cyan(item.quantity),
        String(item.meals),
        chalk.gray(item.servings.join(', ')),
      ]),
    ], {
      gap: ' ',
      columns: [{ width: 32 }, { width: 14 }, { width: 5 }],
    });
    lines.push(...shoppingRows.map(row => `  ${row}`));
  }
  if (anyListResult) {
    lines.push('');
    lines.push(chalk.bold('AnyList'));
    lines.push(`  Created ${chalk.cyan(anyListResult.name)} with ${formatNumber(anyListResult.added)} ingredients.`);
  }
  return `${lines.join('\n')}\n`;
}

function renderMealPlanDayText(day: EraFitMealPlanDay): string {
  return `${renderMealPlanDayLines(day).join('\n')}\n`;
}

function renderMealPlanDayLines(day: EraFitMealPlanDay): string[] {
  const lines: string[] = [];
  const planned = formatMacros(day.planned);
  const target = formatMacros(day.targets);
  lines.push(`${chalk.bold(day.day)} ${chalk.gray(`(${day.template})`)}`);
  lines.push(`  ${chalk.bold('Planned:')} ${planned} ${chalk.gray('|')} ${chalk.bold('Target:')} ${target}`);
  if (day.meals.length === 0) {
    lines.push(chalk.gray('  No suggested meals.'));
    return lines;
  }
  for (const meal of day.meals) {
    lines.push(`  ${chalk.gray(meal.time ? `${formatMealPlanTime(meal.time)} ` : '')}${chalk.bold(meal.meal)}: ${formatMacros(meal.macros)}`);
    if (meal.recipe) {
      lines.push(`    ${chalk.gray('Recipe:')} ${meal.recipe}`);
    }
    const labels = meal.items.map(item => ({ item, label: formatMealPlanItemLabel(item) }));
    const labelWidth = labels.reduce((width, entry) => Math.max(width, visibleLength(entry.label.styled)), 58);
    for (const { item, label } of labels) {
      lines.push(`    ${padVisibleEnd(label.styled, labelWidth)} ${formatMacros(item)}`);
    }
  }
  return lines;
}

function formatMealPlanItemLabel(item: EraFitMealPlanFoodItem): MealItemLabel {
  if (item.description?.trim()) {
    return { styled: styleMealPlanItemDescription(item.description.trim()) };
  }
  const serving = formatMealPlanItemServing(item);
  const name = formatMealPlanItemName(item.name, serving);
  const grams = formatMealItemGrams(item);
  const styled = `${serving ? `${chalk.cyan(serving.text)} ${name}` : name}${grams ? ` ${chalk.cyan(`[${grams}]`)}` : ''}`;
  return { styled };
}

function styleMealPlanItemDescription(value: string): string {
  return value
    .replace(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*[A-Za-z%]*|\d+\s+[A-Za-z]+)/, match => chalk.cyan(match))
    .replace(/\(([^)]*\d[^)]*)\)$/, match => chalk.cyan(match));
}

function formatMealPlanItemServing(item: EraFitMealPlanFoodItem): MealItemServing | null {
  const candidates = uniqueStrings([item.serving, item.description, item.description?.split(':').at(-1) ?? null]
    .filter((value): value is string => value != null));
  for (const candidate of candidates) {
    const serving = parseMealPlanItemServingText(candidate, item);
    if (serving) {
      return serving;
    }
  }
  return null;
}

function parseMealPlanItemServingText(value: string, item: EraFitMealPlanFoodItem): MealItemServing | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*([A-Za-z%]+)?/);
  if (!match) {
    return null;
  }
  const quantity = parseQuantity(match[1]);
  if (quantity == null) {
    return null;
  }
  const text = match[0].trim();
  const rest = trimmed.slice(match[0].length).trim();
  const unit = canonicalShoppingUnit(match[2], rest, item.name);
  if (!unit) {
    return null;
  }
  const measure = {
    quantity,
    unit,
    priority: shoppingUnitPriority(unit),
  };
  if (shouldSuppressMealItemServing(measure, item)) {
    return null;
  }
  return { text, measure };
}

function shouldSuppressMealItemServing(measure: ShoppingMeasure, item: EraFitMealPlanFoodItem): boolean {
  if (measure.unit === 'g' && item.unit === 'g' && item.amount != null && Math.abs(measure.quantity - item.amount) < 0.001) {
    return true;
  }
  return measure.quantity === 1 && ['eggs', 'egg whites', 'bananas', 'avocados'].includes(measure.unit);
}

function formatMealPlanItemName(name: string, serving: MealItemServing | null): string {
  if (!serving) {
    return name;
  }
  const lower = name.toLowerCase();
  const quantity = serving.measure.quantity;
  if (serving.measure.unit === 'avocados' && lower === 'avocados') {
    return quantity <= 1 ? 'Avocado' : 'Avocados';
  }
  if (serving.measure.unit === 'bananas' && lower === 'banana') {
    return quantity === 1 ? 'Banana' : 'Bananas';
  }
  if (serving.measure.unit === 'eggs' && lower.endsWith('egg') && quantity !== 1) {
    return `${name}s`;
  }
  if (serving.measure.unit === 'egg whites' && lower.endsWith('egg white') && quantity !== 1) {
    return `${name}s`;
  }
  return name;
}

function formatMealItemGrams(item: EraFitMealPlanFoodItem): string | null {
  if (item.unit === 'g' && item.amount != null) {
    return `${formatNumber(roundNumber(item.amount))}g`;
  }
  const grams = item.description?.match(/\((\d+(?:\.\d+)?)g\)/i);
  if (!grams) {
    return null;
  }
  const amount = parseNumberLike(grams[1]);
  return amount == null ? null : `${formatNumber(roundNumber(amount))}g`;
}

function formatMacros(value: EraFitMacroTotals): string {
  return [
    chalk.blue(`${formatNullableNumber(value.calories)} kcal`),
    chalk.red(`P ${formatNullableNumber(value.protein)}g`),
    chalk.yellow(`C ${formatNullableNumber(value.net_carbs)}g`),
    chalk.magenta(`F ${formatNullableNumber(value.fat)}g`),
  ].join(' | ');
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '-' : formatNumber(roundNumber(value));
}

function formatMealPlanTime(value: string): string {
  const match = value.match(/^(\d{1,2})(am|pm)$/i);
  if (!match) {
    return value;
  }
  return `${match[1]} ${match[2].toUpperCase()}`;
}
