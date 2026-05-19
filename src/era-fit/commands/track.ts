import { confirm, isCancel, select, text } from '@clack/prompts';
import type { Argv, ArgumentsCamelCase, CommandModule } from 'yargs';

import { loadEraFitCache, normalizeFoodCacheKey, rememberFoodSelection, type EraFitCache } from '../cache';
import {
  fetchEraFitFatSecretFood,
  formatDateKey,
  formatEraFitDateId,
  formatNumber,
  MEAL_LABELS,
  parseLocalDate,
  parseNumberLike,
  parseQuantity,
  readEraFitFirebasePath,
  resolveSession,
  roundNumber,
  searchEraFitFatSecretFoods,
  setEraFitFirebasePath,
  startOfLocalDay,
  updateEraFitFirebasePath,
  type EraFitFatSecretFood,
  type EraFitFatSecretServing,
  type EraFitMealKey,
} from '../core';
import { renderTableRecords } from '../../utils/output';

const STANDARD_UNITS = ['g', 'oz', 'ml', 'fl_oz'] as const;
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
}

interface ParsedTrackItem {
  raw: string;
  amount: number;
  unit: string | null;
  query: string;
  explicitFoodId: string | null;
}

interface ServingChoice {
  type: 'fatsecret' | 'standard';
  label: string;
  description: string;
  servingId?: string;
  unit?: StandardUnit;
}

type StandardUnit = (typeof STANDARD_UNITS)[number];

interface TrackedFoodRecord {
  food_id: string;
  food_name: string;
  food_type: string;
  food_url: string;
  brand_name: string;
  serving_qtd: number;
  serving_unit: string;
  serving_id?: string;
  serving_url?: string;
  serving_description: string;
  metric_serving_amount?: number | string;
  metric_serving_unit?: string;
  measurement_description?: string;
  number_of_units?: number | string;
  added_sugars?: string;
  ef_version?: 1;
  calories: number;
  protein: number;
  carbohydrate: number;
  fat: number;
  saturated_fat: number;
  trans_fat: number;
  polyunsaturated_fat: number;
  monounsaturated_fat: number;
  cholesterol: number;
  sodium: number;
  potassium: number;
  fiber: number;
  sugar: number;
  vitamin_a: number;
  vitamin_c: number;
  vitamin_d: number;
  calcium: number;
  iron: number;
  time: string;
  id?: string;
  meal_tracking_food_log?: string;
}

interface ResolvedTrackFood {
  input: ParsedTrackItem;
  food: EraFitFatSecretFood;
  serving: ServingChoice;
  quantity: number;
  record: TrackedFoodRecord;
}

interface SavedTrackFood extends ResolvedTrackFood {
  id: string;
  logId: string;
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
      describe: 'Foods as count [unit] name|id, separated with semicolons, for example "50g chicken breast; 1 banana"',
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
      describe: 'Resolve foods and servings but do not write to Era Fit',
    }) as unknown as Argv<T & TrackCliArgs>;
}

async function runTrackCommand(args: ArgumentsCamelCase<TrackCliArgs>): Promise<void> {
  const { meal, itemArgs } = resolveMealAndItemArgs(args.meal, args.items ?? []);
  const parsedItems = splitTrackItemArgs(itemArgs).map(parseTrackItem);
  if (parsedItems.length === 0) {
    throw new Error('Add at least one food item, for example: era-fit track b "50g chicken breast; 1 banana".');
  }
  if (await shouldExitForPossibleMissingSeparator(parsedItems)) {
    return;
  }

  const date = args.date ? parseLocalDate(args.date, 'date') : startOfLocalDay(new Date());
  const time = args.time?.trim() || formatEraFitTime(new Date());
  const dateId = formatEraFitDateId(date);
  const session = await resolveSession();
  const cache = loadEraFitCache();

  const foods: ResolvedTrackFood[] = [];
  for (const item of parsedItems) {
    foods.push(await resolveTrackFood(session, cache, item, time, { writeCache: !args.dryRun }));
  }

  const saved = args.dryRun
    ? foods.map(food => ({ ...food, id: '(dry-run)', logId: '(dry-run)' }))
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
  if (!raw.includes(';')) {
    return [raw];
  }
  const items = raw.split(';').map(part => part.trim());
  if (items.some(item => item.length === 0)) {
    throw new Error('Food items must be separated by `;` without empty entries.');
  }
  return items;
}

function parseTrackItem(raw: string): ParsedTrackItem {
  const parsed = tryParseTrackItem(raw);
  if (!parsed) {
    throw new Error(`Could not parse food item "${raw}". Expected count [unit] name|id, for example "50g chicken breast". Separate multiple foods with \`; \`.`);
  }
  return parsed;
}

function tryParseTrackItem(raw: string): ParsedTrackItem | null {
  const match = raw.trim().match(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*([A-Za-z_][A-Za-z_.%/-]*)?\s+(.+)$/);
  if (!match) {
    return null;
  }
  const amount = parseQuantity(match[1]);
  if (amount == null || amount <= 0) {
    return null;
  }
  const unit = normalizeRequestedUnit(match[2] ?? null);
  let query = match[3].trim();
  let explicitFoodId: string | null = null;
  const pipeIndex = query.lastIndexOf('|');
  if (pipeIndex !== -1) {
    explicitFoodId = query.slice(pipeIndex + 1).trim() || null;
    query = query.slice(0, pipeIndex).trim() || explicitFoodId || query;
  } else if (/^\d+$/.test(query)) {
    explicitFoodId = query;
  }
  if (!query) {
    return null;
  }
  return {
    raw,
    amount,
    unit,
    query,
    explicitFoodId,
  };
}

async function shouldExitForPossibleMissingSeparator(items: ParsedTrackItem[]): Promise<boolean> {
  if (items.length !== 1 || !hasPossibleMissingFoodSeparator(items[0])) {
    return false;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('This looks like multiple foods. Separate foods with `;`, for example "50g chicken breast; 1 banana".');
    process.exit(1);
  }
  const answer = await confirm({
    message: 'did you forget to separate foods by `;`?',
    initialValue: true,
  });
  if (isCancel(answer)) {
    throw new Error('Era Fit food logging cancelled.');
  }
  return answer;
}

function hasPossibleMissingFoodSeparator(item: ParsedTrackItem): boolean {
  const match = item.raw.trim().match(/^(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*([A-Za-z_][A-Za-z_.%/-]*)?\s+(.+)$/);
  const rest = match?.[3] ?? '';
  return /(?:^|\s)(?:\d+\s*\/\s*\d+|\d+(?:\.\d+)?)(?!\s*%)(?:\s*(?:g|grams?|oz|ounces?|ml|milliliters?|fl_?oz|cups?|tbsp|tsp|servings?|slices?|pieces?|scoops?|packets?)\b)?(?=\s+[A-Za-z])/.test(rest);
}

async function resolveTrackFood(
  session: Awaited<ReturnType<typeof resolveSession>>,
  cache: EraFitCache,
  item: ParsedTrackItem,
  time: string,
  options: { writeCache: boolean }
): Promise<ResolvedTrackFood> {
  const cached = item.explicitFoodId ? null : cache.foods[normalizeFoodCacheKey(item.query)];
  if (cached) {
    const food = await fetchEraFitFatSecretFood(session, cached.foodId);
    const requestedServing = item.unit ? resolveAutoServingChoice(food, item) : null;
    const serving = requestedServing ?? (!item.unit ? servingFromCache(food, cached) : null);
    if (serving) {
      const quantity = defaultQuantityForServing(item, serving, food, item.amount);
      return {
        input: item,
        food,
        serving,
        quantity,
        record: buildTrackedFoodRecord(food, serving, quantity, time),
      };
    }
  }

  const food = item.explicitFoodId
    ? await fetchEraFitFatSecretFood(session, item.explicitFoodId)
    : await resolveFoodFromSearch(session, item);
  const forceServingPrompt = !item.explicitFoodId && !isExactFoodMatch(food, item.query);
  const serving = await resolveServingChoice(food, item, forceServingPrompt);
  const quantity = forceServingPrompt
    ? await promptForQuantity(item, serving, food)
    : defaultQuantityForServing(item, serving, food, item.amount);

  if (options.writeCache) {
    rememberFoodSelection(cache, item.query, {
      foodId: food.food_id,
      foodName: food.food_name,
      brandName: food.brand_name,
      servingType: serving.type,
      servingId: serving.servingId,
      servingUnit: serving.unit,
      servingDescription: serving.description,
    });
  }

  return {
    input: item,
    food,
    serving,
    quantity,
    record: buildTrackedFoodRecord(food, serving, quantity, time),
  };
}

async function resolveFoodFromSearch(
  session: Awaited<ReturnType<typeof resolveSession>>,
  item: ParsedTrackItem
): Promise<EraFitFatSecretFood> {
  const results = (await searchEraFitFatSecretFoods(session, item.query)).slice(0, 10);
  if (results.length === 0) {
    throw new Error(`No Era Fit food results for "${item.query}".`);
  }

  const exactMatches = results.filter(result => normalizeFoodCacheKey(result.food_name) === normalizeFoodCacheKey(item.query));
  if (exactMatches.length === 1) {
    const food = await fetchEraFitFatSecretFood(session, exactMatches[0].food_id);
    if (resolveAutoServingChoice(food, item)) {
      return food;
    }
  }

  process.stdout.write(`\nSearch results for "${item.query}"\n`);
  renderTableRecords(results.map((result, index) => ({
    '#': index + 1,
    id: result.food_id,
    name: result.food_name,
    brand: result.brand_name ?? '',
    serving: parseSearchServing(result.food_description),
    ...parseSearchMacros(result.food_description),
  })));

  const selected = await select({
    message: `Select food for ${item.raw}`,
    options: results.map(result => ({
      value: result.food_id,
      label: `${result.food_name}${result.brand_name ? ` (${result.brand_name})` : ''}`,
      hint: parseSearchServing(result.food_description),
    })),
  });
  if (isCancel(selected)) {
    throw new Error('Era Fit food selection cancelled.');
  }
  return fetchEraFitFatSecretFood(session, selected);
}

async function resolveServingChoice(
  food: EraFitFatSecretFood,
  item: ParsedTrackItem,
  forcePrompt: boolean
): Promise<ServingChoice> {
  const auto = resolveAutoServingChoice(food, item);
  if (auto && !forcePrompt) {
    return auto;
  }
  const choices = buildServingChoices(food);
  if (choices.length === 0) {
    throw new Error(`Era Fit returned no servings for ${food.food_name}.`);
  }
  const selected = await select({
    message: `Select serving for ${food.food_name}`,
    options: choices.map((choice, index) => ({
      value: String(index),
      label: choice.label,
    })),
    initialValue: auto ? String(choices.findIndex(choice => sameServingChoice(choice, auto))) : undefined,
  });
  if (isCancel(selected)) {
    throw new Error('Era Fit serving selection cancelled.');
  }
  return choices[Number(selected)];
}

async function promptForQuantity(
  item: ParsedTrackItem,
  serving: ServingChoice,
  food: EraFitFatSecretFood
): Promise<number> {
  const initialValue = formatNumber(defaultQuantityForServing(item, serving, food, item.amount));
  const value = await text({
    message: `Amount for ${serving.description}`,
    initialValue,
    validate(input) {
      const parsed = parseQuantity(input?.trim() ?? '');
      return parsed != null && parsed > 0 ? undefined : 'Enter a positive number.';
    },
  });
  if (isCancel(value)) {
    throw new Error('Era Fit amount entry cancelled.');
  }
  return parseQuantity(value.trim()) ?? Number(initialValue);
}

function servingFromCache(food: EraFitFatSecretFood, cached: EraFitCache['foods'][string]): ServingChoice | null {
  if (cached.servingType === 'standard') {
    const unit = parseStandardUnit(cached.servingUnit);
    return unit && buildServingChoices(food).some(choice => choice.type === 'standard' && choice.unit === unit)
      ? {
        type: 'standard',
        unit,
        label: standardUnitLabel(unit),
        description: cached.servingDescription,
      }
      : null;
  }
  if (!cached.servingId || !food.servings[cached.servingId]) {
    return null;
  }
  const serving = food.servings[cached.servingId];
  return {
    type: 'fatsecret',
    servingId: serving.serving_id,
    label: serving.serving_description,
    description: serving.serving_description,
  };
}

function resolveAutoServingChoice(food: EraFitFatSecretFood, item: ParsedTrackItem): ServingChoice | null {
  const unit = parseStandardUnit(item.unit);
  if (unit && buildServingChoices(food).some(choice => choice.type === 'standard' && choice.unit === unit)) {
    return {
      type: 'standard',
      unit,
      label: standardUnitLabel(unit),
      description: unit,
    };
  }

  const servings = Object.values(food.servings);
  if (item.unit) {
    const match = servings.find(serving => servingMatchesRequest(serving, item));
    if (match) {
      return {
        type: 'fatsecret',
        servingId: match.serving_id,
        label: match.serving_description,
        description: match.serving_description,
      };
    }
  }
  if (!item.unit && servings.length === 1) {
    return {
      type: 'fatsecret',
      servingId: servings[0].serving_id,
      label: servings[0].serving_description,
      description: servings[0].serving_description,
    };
  }
  return null;
}

function buildServingChoices(food: EraFitFatSecretFood): ServingChoice[] {
  const servings = Object.values(food.servings);
  const choices: ServingChoice[] = servings.map(serving => ({
    type: 'fatsecret',
    servingId: serving.serving_id,
    label: serving.serving_description,
    description: serving.serving_description,
  }));
  const unitType = getUnitType(servings);
  if (unitType === 'mass') {
    choices.push(
      { type: 'standard', unit: 'g', label: standardUnitLabel('g'), description: 'g' },
      { type: 'standard', unit: 'oz', label: standardUnitLabel('oz'), description: 'oz' }
    );
  } else if (unitType === 'volume') {
    choices.push(
      { type: 'standard', unit: 'ml', label: standardUnitLabel('ml'), description: 'ml' },
      { type: 'standard', unit: 'fl_oz', label: standardUnitLabel('fl_oz'), description: 'fl_oz' }
    );
  }
  return choices;
}

function buildTrackedFoodRecord(
  food: EraFitFatSecretFood,
  servingChoice: ServingChoice,
  quantity: number,
  time: string
): TrackedFoodRecord {
  const foodInfo = {
    food_id: food.food_id,
    food_name: food.food_name,
    food_type: food.food_type,
    food_url: food.food_url,
    brand_name: food.brand_name ?? '',
  };

  if (servingChoice.type === 'standard') {
    const unit = servingChoice.unit;
    if (!unit) {
      throw new Error(`No standard serving unit selected for ${food.food_name}.`);
    }
    const bestServing = selectBestServing(Object.values(food.servings)).serving;
    const perUnit = bestServing ? calculatePerUnitNutrition(bestServing, getUnitType([bestServing]) ?? 'mass', foodInfo) : null;
    if (!perUnit) {
      throw new Error(`Cannot calculate ${unit} serving for ${food.food_name}.`);
    }
    return cleanFoodRecord({
      ...calculateNutritionByUnit(quantity, unit, perUnit),
      serving_id: bestServing?.serving_id ?? '',
      serving_url: bestServing?.serving_url ?? '',
      metric_serving_amount: parseNumberLike(bestServing?.metric_serving_amount) ?? '',
      metric_serving_unit: bestServing?.metric_serving_unit ?? '',
      measurement_description: bestServing?.measurement_description ?? '',
      number_of_units: parseNumberLike(bestServing?.number_of_units) ?? '',
      added_sugars: bestServing?.added_sugars ?? '',
      time,
    });
  }

  const serving = food.servings[servingChoice.servingId ?? ''];
  if (!serving) {
    throw new Error(`Unknown serving ${servingChoice.servingId} for ${food.food_name}.`);
  }
  return cleanFoodRecord({
    ...calculateFatSecretServing(serving, quantity, foodInfo),
    serving_url: serving.serving_url ?? '',
    metric_serving_amount: parseNumberLike(serving.metric_serving_amount) ?? '',
    metric_serving_unit: serving.metric_serving_unit ?? '',
    measurement_description: serving.measurement_description ?? '',
    number_of_units: parseNumberLike(serving.number_of_units) ?? '',
    added_sugars: serving.added_sugars ?? '',
    time,
  });
}

async function saveTrackedFoods(
  session: Awaited<ReturnType<typeof resolveSession>>,
  options: {
    dateId: string;
    meal: EraFitMealKey;
    foods: ResolvedTrackFood[];
  }
): Promise<SavedTrackFood[]> {
  const saved: SavedTrackFood[] = [];
  for (const food of options.foods) {
    const id = generateNutritionId();
    const logId = `${options.dateId}_${options.meal}_${id}`;
    const record = {
      ...food.record,
      id,
      meal_tracking_food_log: logId,
    };
    await setEraFitFirebasePath(
      session,
      `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking/data/${options.dateId}/meals/${options.meal}/foods/${id}`,
      record
    );
    await setEraFitFirebasePath(
      session,
      `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking_food_data/${logId}`,
      record
    );
    saved.push({
      ...food,
      record,
      id,
      logId,
    });
  }
  await saveMealTrackingTotals(session, options.dateId);
  return saved;
}

async function saveMealTrackingTotals(session: Awaited<ReturnType<typeof resolveSession>>, dateId: string): Promise<void> {
  const basePath = `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking`;
  const meals = await readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/data/${dateId}/meals`) ?? {};
  const dayTotal = { protein: 0, net_carbs: 0, fat: 0, energy: 0 };

  for (const [mealKey, rawMeal] of Object.entries(meals)) {
    const foods = asRecord(rawMeal)?.foods;
    if (!foods) {
      continue;
    }
    const total = Object.values(foods).reduce((sum, rawFood) => addMacroTotals(sum, calculateFoodTotals(asRecord(rawFood))), {
      protein: 0,
      net_carbs: 0,
      fat: 0,
      energy: 0,
    });
    const rounded = roundTotals(total);
    await setEraFitFirebasePath(session, `${basePath}/data/${dateId}/meals/${mealKey}/total`, rounded);
    addMacroTotals(dayTotal, rounded);
  }

  const existingTotal = await readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/total/${dateId}`) ?? {};
  await updateEraFitFirebasePath(session, `${basePath}/total/${dateId}`, {
    ...roundTotals(dayTotal),
    status_day: typeof existingTotal.status_day === 'string' ? existingTotal.status_day : 'non_completed',
  });
}

function calculateFoodTotals(food: Record<string, unknown> | null): { protein: number; net_carbs: number; fat: number; energy: number } {
  if (!food) {
    return { protein: 0, net_carbs: 0, fat: 0, energy: 0 };
  }
  const type = typeof food.type_item === 'string' ? food.type_item : null;
  if (type === 'my_meals') {
    const total = asRecord(food.total);
    const servingQuantity = parseNumberLike(food.serving_qtd) ?? 1;
    return {
      protein: (parseNumberLike(total?.protein) ?? 0) * servingQuantity,
      net_carbs: (parseNumberLike(total?.net_carbs) ?? 0) * servingQuantity,
      fat: (parseNumberLike(total?.fat) ?? 0) * servingQuantity,
      energy: (parseNumberLike(total?.energy) ?? 0) * servingQuantity,
    };
  }
  const multiplier = type === 'food_customized' || type === 'food_global'
    ? food.ef_version === 1 ? 1 : parseNumberLike(food.serving_qtd) ?? 1
    : 1;
  return {
    protein: (parseNumberLike(food.protein) ?? 0) * multiplier,
    net_carbs: ((parseNumberLike(food.net_carbs) ?? parseNumberLike(food.carbohydrate)) ?? 0) * multiplier,
    fat: (parseNumberLike(food.fat) ?? 0) * multiplier,
    energy: (parseNumberLike(food.energy) ?? parseNumberLike(food.calories) ?? 0) * multiplier,
  };
}

function renderTrackResult(options: {
  date: string;
  meal: EraFitMealKey;
  saved: SavedTrackFood[];
  dryRun: boolean;
}): void {
  process.stdout.write(`${options.dryRun ? 'Dry Run' : 'Logged Foods'} - ${options.date} ${MEAL_LABELS[options.meal]}\n`);
  renderTableRecords(options.saved.map(food => ({
    item: food.record.food_name,
    brand: food.record.brand_name || null,
    serving: food.record.serving_description,
    quantity: formatNumber(food.record.serving_qtd),
    calories: food.record.calories,
    protein: food.record.protein,
    net_carbs: food.record.carbohydrate,
    fat: food.record.fat,
    id: food.id,
  })));
}

function calculateFatSecretServing(
  serving: EraFitFatSecretServing,
  quantity: number,
  foodInfo: Pick<TrackedFoodRecord, 'food_id' | 'food_name' | 'food_type' | 'food_url' | 'brand_name'>
): TrackedFoodRecord {
  return {
    ...foodInfo,
    serving_qtd: quantity,
    serving_unit: 'fatsecret',
    serving_id: serving.serving_id,
    serving_description: serving.serving_description,
    calories: numeric(serving.calories) * quantity,
    protein: numeric(serving.protein) * quantity,
    carbohydrate: numeric(serving.carbohydrate) * quantity,
    fat: numeric(serving.fat) * quantity,
    saturated_fat: numeric(serving.saturated_fat) * quantity,
    trans_fat: numeric(serving.trans_fat) * quantity,
    polyunsaturated_fat: numeric(serving.polyunsaturated_fat) * quantity,
    monounsaturated_fat: numeric(serving.monounsaturated_fat) * quantity,
    cholesterol: numeric(serving.cholesterol) * quantity,
    sodium: numeric(serving.sodium) * quantity,
    potassium: numeric(serving.potassium) * quantity,
    fiber: numeric(serving.fiber) * quantity,
    sugar: numeric(serving.sugar) * quantity,
    vitamin_a: numeric(serving.vitamin_a) * quantity,
    vitamin_c: numeric(serving.vitamin_c) * quantity,
    vitamin_d: numeric(serving.vitamin_d) * quantity,
    calcium: numeric(serving.calcium) * quantity,
    iron: numeric(serving.iron) * quantity,
    time: '',
  };
}

function calculatePerUnitNutrition(
  serving: EraFitFatSecretServing,
  unitType: 'mass' | 'volume',
  foodInfo: Pick<TrackedFoodRecord, 'food_id' | 'food_name' | 'food_type' | 'food_url' | 'brand_name'>
): TrackedFoodRecord & { unit_type: 'mass' | 'volume' } | null {
  const metricAmount = parseNumberLike(serving.metric_serving_amount);
  if (!metricAmount || metricAmount <= 0) {
    return null;
  }
  const baseAmount = unitType === 'mass'
    ? metricAmount * (serving.metric_serving_unit === 'oz' ? 28.3495 : 1)
    : metricAmount;
  return {
    ...calculateFatSecretServing(serving, 1 / baseAmount, foodInfo),
    serving_qtd: 1,
    serving_unit: unitType === 'mass' ? 'g' : 'ml',
    serving_description: unitType === 'mass' ? '1 g' : '1 ml',
    unit_type: unitType,
  };
}

function calculateNutritionByUnit(
  quantity: number,
  unit: StandardUnit,
  perUnit: TrackedFoodRecord & { unit_type: 'mass' | 'volume' }
): TrackedFoodRecord {
  const conversions = perUnit.unit_type === 'mass'
    ? { g: 1, oz: 28.3495 }
    : { ml: 1, fl_oz: 30 };
  const baseAmount = quantity * (conversions[unit as keyof typeof conversions] ?? 1);
  return {
    ...perUnit,
    ef_version: 1,
    serving_qtd: quantity,
    serving_unit: unit,
    serving_description: `${formatNumber(quantity)} ${unit}`,
    calories: perUnit.calories * baseAmount,
    protein: perUnit.protein * baseAmount,
    carbohydrate: perUnit.carbohydrate * baseAmount,
    fat: perUnit.fat * baseAmount,
    saturated_fat: perUnit.saturated_fat * baseAmount,
    trans_fat: perUnit.trans_fat * baseAmount,
    polyunsaturated_fat: perUnit.polyunsaturated_fat * baseAmount,
    monounsaturated_fat: perUnit.monounsaturated_fat * baseAmount,
    cholesterol: perUnit.cholesterol * baseAmount,
    sodium: perUnit.sodium * baseAmount,
    potassium: perUnit.potassium * baseAmount,
    fiber: perUnit.fiber * baseAmount,
    sugar: perUnit.sugar * baseAmount,
    vitamin_a: perUnit.vitamin_a * baseAmount,
    vitamin_c: perUnit.vitamin_c * baseAmount,
    vitamin_d: perUnit.vitamin_d * baseAmount,
    calcium: perUnit.calcium * baseAmount,
    iron: perUnit.iron * baseAmount,
  };
}

function cleanFoodRecord(record: TrackedFoodRecord): TrackedFoodRecord {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== '' && value != null)
      .map(([key, value]) => [key, typeof value === 'number' ? roundNumber(value) : value])
  ) as unknown as TrackedFoodRecord;
}

function selectBestServing(servings: EraFitFatSecretServing[]): { serving: EraFitFatSecretServing | null; unitType: 'mass' | 'volume' | null } {
  const serving100g = servings.find(serving => parseNumberLike(serving.metric_serving_amount) === 100 && serving.metric_serving_unit === 'g');
  if (serving100g) return { serving: serving100g, unitType: 'mass' };
  const grams = servings.find(serving => serving.metric_serving_unit === 'g');
  if (grams) return { serving: grams, unitType: 'mass' };
  const oz = servings.find(serving => serving.metric_serving_unit === 'oz');
  if (oz) return { serving: oz, unitType: 'mass' };
  const ml = servings.find(serving => serving.metric_serving_unit === 'ml');
  if (ml) return { serving: ml, unitType: 'volume' };
  return { serving: servings[0] ?? null, unitType: null };
}

function getUnitType(servings: EraFitFatSecretServing[]): 'mass' | 'volume' | null {
  if (servings.some(serving => serving.metric_serving_unit === 'g' || serving.metric_serving_unit === 'oz')) {
    return 'mass';
  }
  if (servings.some(serving => serving.metric_serving_unit === 'ml')) {
    return 'volume';
  }
  return null;
}

function defaultQuantityForServing(
  item: ParsedTrackItem,
  serving: ServingChoice,
  food: EraFitFatSecretFood,
  fallback: number
): number {
  if (serving.type === 'standard') {
    return fallback;
  }
  const selectedServing = food.servings[serving.servingId ?? ''];
  if (!item.unit || !selectedServing) {
    return fallback;
  }
  const requestedUnit = parseStandardUnit(item.unit);
  if (!requestedUnit) {
    return fallback;
  }
  const requestedAmount = convertStandardAmount(item.amount, requestedUnit, selectedServing.metric_serving_unit);
  const servingAmount = parseNumberLike(selectedServing.metric_serving_amount);
  return requestedAmount != null && servingAmount && servingAmount > 0
    ? roundNumber(requestedAmount / servingAmount)
    : fallback;
}

function convertStandardAmount(amount: number, from: StandardUnit, to: string | undefined): number | null {
  if (from === to) {
    return amount;
  }
  if (from === 'g' && to === 'oz') return amount / 28.3495;
  if (from === 'oz' && to === 'g') return amount * 28.3495;
  if (from === 'ml' && to === 'fl_oz') return amount / 30;
  if (from === 'fl_oz' && to === 'ml') return amount * 30;
  return null;
}

function servingMatchesRequest(serving: EraFitFatSecretServing, item: ParsedTrackItem): boolean {
  const unit = item.unit?.replaceAll('_', ' ');
  if (!unit) {
    return false;
  }
  const description = serving.serving_description.toLowerCase().replaceAll('_', ' ');
  return description.includes(unit.toLowerCase());
}

function parseStandardUnit(value: string | null | undefined): StandardUnit | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase().replaceAll(/\s+/g, '_');
  if (['g', 'gram', 'grams'].includes(normalized)) return 'g';
  if (['oz', 'ounce', 'ounces'].includes(normalized)) return 'oz';
  if (['ml', 'milliliter', 'milliliters'].includes(normalized)) return 'ml';
  if (['fl_oz', 'floz', 'fluid_ounce', 'fluid_ounces'].includes(normalized)) return 'fl_oz';
  return null;
}

function normalizeRequestedUnit(value: string | null): string | null {
  return parseStandardUnit(value) ?? value?.toLowerCase() ?? null;
}

function standardUnitLabel(unit: StandardUnit): string {
  const labels: Record<StandardUnit, string> = {
    g: '1 g (Grams)',
    oz: '1 oz (Ounces)',
    ml: '1 ml (Milliliters)',
    fl_oz: '1 fl oz (Fluid Ounces)',
  };
  return labels[unit];
}

function sameServingChoice(left: ServingChoice, right: ServingChoice): boolean {
  return left.type === right.type && left.servingId === right.servingId && left.unit === right.unit;
}

function isExactFoodMatch(food: EraFitFatSecretFood, query: string): boolean {
  return normalizeFoodCacheKey(food.food_name) === normalizeFoodCacheKey(query);
}

function addMacroTotals<T extends { protein: number; net_carbs: number; fat: number; energy: number }>(target: T, value: {
  protein: number;
  net_carbs: number;
  fat: number;
  energy: number;
}): T {
  target.protein += value.protein;
  target.net_carbs += value.net_carbs;
  target.fat += value.fat;
  target.energy += value.energy;
  return target;
}

function roundTotals(total: { protein: number; net_carbs: number; fat: number; energy: number }): {
  protein: number;
  net_carbs: number;
  fat: number;
  energy: number;
} {
  return {
    protein: Number(total.protein.toFixed(1)),
    net_carbs: Number(total.net_carbs.toFixed(1)),
    fat: Number(total.fat.toFixed(1)),
    energy: Number(total.energy.toFixed(0)),
  };
}

function parseSearchServing(description: string): string {
  return description.split('-')[0]?.trim() ?? description;
}

function parseSearchMacros(description: string): { calories: number | null; protein: number | null; carbs: number | null; fat: number | null } {
  return {
    calories: parseNumberLike(description.match(/Calories:\s*([\d.]+)/i)?.[1]),
    protein: parseNumberLike(description.match(/Protein:\s*([\d.]+)/i)?.[1]),
    carbs: parseNumberLike(description.match(/Carbs:\s*([\d.]+)/i)?.[1]),
    fat: parseNumberLike(description.match(/Fat:\s*([\d.]+)/i)?.[1]),
  };
}

function numeric(value: unknown): number {
  return parseNumberLike(value) ?? 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function generateNutritionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 20);
}

function formatEraFitTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}
