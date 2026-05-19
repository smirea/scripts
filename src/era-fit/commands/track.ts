import { confirm, isCancel } from '@clack/prompts';
import chalk from 'chalk';
import type { Argv, ArgumentsCamelCase, CommandModule } from 'yargs';

import { loadEraFitCache } from '../cache';
import {
  formatDateKey,
  formatEraFitDateId,
  formatNumber,
  MEAL_LABELS,
  parseLocalDate,
  resolveSession,
  startOfLocalDay,
  type EraFitSessionLogger,
  type EraFitMealKey,
} from '../core';
import {
  formatEraFitTime,
  isBarcodeQuery,
  parseTrackItem,
  resolveTrackFood,
  saveTrackedFoods,
  type ParsedTrackItem,
  type ResolvedTrackFood,
  type TrackResultFood,
} from '../tracking';
import { renderTableRecords } from '../../utils/output';

const MEAL_ALIASES: Record<string, EraFitMealKey> = {
  b: 'breakfast',
  breakfast: 'breakfast',
  s1: 'snack_am',
  snackam: 'snack_am',
  'snack-am': 'snack_am',
  snack_am: 'snack_am',
  am: 'snack_am',
  'am-snack': 'snack_am',
  l: 'lunch',
  lunch: 'lunch',
  s2: 'snack_pm',
  snackpm: 'snack_pm',
  'snack-pm': 'snack_pm',
  snack_pm: 'snack_pm',
  pm: 'snack_pm',
  'pm-snack': 'snack_pm',
  d: 'dinner',
  dinner: 'dinner',
  s3: 'snack_evening',
  snackevening: 'snack_evening',
  'snack-evening': 'snack_evening',
  snack_evening: 'snack_evening',
  evening: 'snack_evening',
  'evening-snack': 'snack_evening',
};

interface TrackCliArgs {
  meal?: string;
  items: string[];
  date?: string;
  time?: string;
  dryRun: boolean;
  cache: boolean;
}

export const trackCommand = {
  command: 'track [meal] [items..]',
  describe: 'Log foods to the Era Fit nutrition tracker',
  builder: addTrackOptions,
  handler: runTrackCommand,
} satisfies CommandModule<{}, TrackCliArgs>;

function addTrackOptions<T>(parser: Argv<T>): Argv<T & TrackCliArgs> {
  return parser
    .positional('meal', {
      type: 'string',
      describe: 'Optional meal: b/breakfast, s1/snack-am, l/lunch, s2/snack-pm, d/dinner, s3/snack-evening',
    })
    .positional('items', {
      type: 'string',
      array: true,
      describe: 'Foods as count [unit] name|id, separated with commas',
    })
    .option('date', {
      type: 'string',
      describe: 'Local date to log, in YYYY-MM-DD format. Defaults to today',
    })
    .option('time', {
      type: 'string',
      describe: 'Time label to store in Era Fit, for example "12:30 PM". Defaults to now',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Resolve foods and servings, but do not write to Era Fit or update the cache',
    })
    .option('cache', {
      type: 'boolean',
      default: true,
      describe: 'Use cached food and serving selections. Pass --no-cache to force lookup',
    })
    .example('$0 track s1 1 banana, 2scoop boba protein powder', 'Log multiple foods separated with commas') as unknown as Argv<T & TrackCliArgs>;
}

async function runTrackCommand(args: ArgumentsCamelCase<TrackCliArgs>): Promise<void> {
  const { meal, itemArgs } = resolveMealAndItemArgs(args.meal, args.items ?? []);
  const parsedItems = splitTrackItemArgs(itemArgs).map(parseTrackItem);
  if (parsedItems.length === 0) {
    throw new Error('Add at least one food item, for example: era-fit track b 50g chicken breast, 1 banana.');
  }
  if (await shouldExitForPossibleMissingSeparator(parsedItems)) {
    return;
  }

  const date = args.date ? parseLocalDate(args.date, 'date') : startOfLocalDay(new Date());
  const time = args.time?.trim() || formatEraFitTime(new Date());
  const dateId = formatEraFitDateId(date);
  const session = await resolveSession(createTrackSessionLogger());
  const cache = loadEraFitCache();

  const foods: ResolvedTrackFood[] = [];
  for (const item of parsedItems) {
    const result = await resolveTrackFood(session, cache, item, time, {
      useCache: args.cache,
      writeCache: args.cache && !args.dryRun,
      log: logTrackProgress,
    });
    if (result.status === 'cancel') {
      logTrackProgress(chalk.gray('cancelled'));
      return;
    }
    if (result.status === 'skip') {
      logTrackProgress(`${chalk.yellow('skipped')} ${chalk.cyan(item.raw)}`);
      continue;
    }
    logTrackProgress(`${chalk.green('matched')} ${chalk.bold(result.food.record.food_name)} ${chalk.gray('to')} ${chalk.cyan(item.raw)}`);
    foods.push(result.food);
  }

  if (foods.length === 0) {
    logTrackProgress(chalk.gray('no foods to log'));
    return;
  }

  const saved = args.dryRun
    ? foods
    : await saveTrackedFoods(session, {
      dateId,
      meal,
      foods,
    });

  renderTrackResult({
    date: formatDateKey(date),
    meal,
    saved,
    dryRun: args.dryRun,
  });
}

function createTrackSessionLogger(): EraFitSessionLogger {
  return {
    loginStart(source) {
      const suffix = source === 'env' ? chalk.gray(' with env credentials') : chalk.gray(' from prompt');
      logTrackProgress(`${chalk.yellow('logging in')}${suffix}`);
    },
    sessionReady(source) {
      if (source === 'cookie') {
        logTrackProgress(chalk.gray('using cached session'));
      } else {
        logTrackProgress(chalk.green('logged in'));
      }
    },
  };
}

function logTrackProgress(message: string): void {
  process.stderr.write(`${message}\n`);
}

function resolveMealAndItemArgs(rawMeal: string | undefined, rawItems: string[]): {
  meal: EraFitMealKey;
  itemArgs: string[];
} {
  const meal = rawMeal ? parseMealAlias(rawMeal) : null;
  if (meal) {
    return { meal, itemArgs: rawItems };
  }
  return {
    meal: inferMealFromTime(new Date()),
    itemArgs: [rawMeal, ...rawItems].filter((value): value is string => !!value?.trim()),
  };
}

function parseMealAlias(value: string): EraFitMealKey | null {
  const normalized = value.toLowerCase().trim();
  return MEAL_ALIASES[normalized] ?? MEAL_ALIASES[normalized.replaceAll(/[_\s]+/g, '-')] ?? null;
}

function inferMealFromTime(date: Date): EraFitMealKey {
  const hour = date.getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 12) return 'snack_am';
  if (hour < 15) return 'lunch';
  if (hour < 17) return 'snack_pm';
  if (hour < 21) return 'dinner';
  return 'snack_evening';
}

function splitTrackItemArgs(parts: string[]): string[] {
  const raw = parts.map(part => part.trim()).filter(Boolean).join(' ').trim();
  if (!raw) {
    return [];
  }
  if (!raw.includes(',')) {
    return [raw];
  }
  const items = raw.split(',').map(part => part.trim());
  if (items.some(item => item.length === 0)) {
    throw new Error('Food items must be separated by `,` without empty entries.');
  }
  return items;
}

async function shouldExitForPossibleMissingSeparator(items: ParsedTrackItem[]): Promise<boolean> {
  if (items.length !== 1 || !hasPossibleMissingFoodSeparator(items[0])) {
    return false;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('This looks like multiple foods. Separate foods with `,`, for example "50g chicken breast, 1 banana".');
    process.exit(1);
  }
  const answer = await confirm({
    message: 'did you forget to separate foods by `,`?',
    initialValue: true,
  });
  if (isCancel(answer)) {
    return true;
  }
  return answer;
}

function hasPossibleMissingFoodSeparator(item: ParsedTrackItem): boolean {
  const match = item.raw.trim().match(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*([A-Za-z_][A-Za-z_.%/-]*)?\s+(.+)$/);
  const rest = match?.[3] ?? '';
  if (isBarcodeQuery(rest.trim())) {
    return false;
  }
  return hasPossibleTextFoodSeparator(rest) || hasPossibleBarcodeFoodSeparator(rest);
}

function hasPossibleTextFoodSeparator(value: string): boolean {
  return /(?:^|\s)(?:\d+\s*\/\s*\d+|\d+(?:\.\d+)?)(?!\s*%)(?:\s*(?:g|grams?|oz|ounces?|ml|milliliters?|fl_?oz|cups?|tbsp|tsp|servings?|slices?|pieces?|scoops?|packets?)\b)?(?=\s+[A-Za-z])/.test(value);
}

function hasPossibleBarcodeFoodSeparator(value: string): boolean {
  return /(?:^|\s)(?:\d+\s*\/\s*\d+|\d+(?:\.\d+)?)(?!\s*%)(?:\s*(?:g|grams?|oz|ounces?|ml|milliliters?|fl_?oz|cups?|tbsp|tsp|servings?|slices?|pieces?|scoops?|packets?)\b)?(?=\s+\d{6,}\b)/.test(value);
}

function renderTrackResult(options: {
  date: string;
  meal: EraFitMealKey;
  saved: TrackResultFood[];
  dryRun: boolean;
}): void {
  process.stdout.write(`${options.dryRun ? 'Would Log Foods' : 'Logged Foods'} - ${options.date} ${MEAL_LABELS[options.meal]}${options.dryRun ? ' (dry run)' : ''}\n`);
  renderTableRecords(options.saved.map(food => {
    const row: Record<string, string | number | null> = {
      time: food.record.time,
      item: food.record.food_name,
      brand: food.record.brand_name || null,
      serving: food.record.serving_description,
      quantity: formatNumber(food.record.serving_qtd),
      calories: food.record.calories,
      protein: food.record.protein,
      net_carbs: food.record.carbohydrate,
      fat: food.record.fat,
    };
    if (!options.dryRun) {
      row.id = 'id' in food ? food.id : null;
    }
    return row;
  }));
  if (options.dryRun) {
    process.stdout.write('No Era Fit changes were written and the cache was not updated.\n');
  }
}
