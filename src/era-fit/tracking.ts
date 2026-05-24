import { emitKeypressEvents } from 'node:readline';

import { isCancel, select, text } from '@clack/prompts';
import chalk from 'chalk';

import { formatTabularRows } from '../utils/tabular';
import { normalizeFoodCacheKey, rememberFoodSelection, type CachedFoodSelection, type EraFitCache } from './cache';
import {
  fetchEraFitFatSecretFood,
  fetchEraFitFatSecretFoodByBarcode,
  formatNumber,
  isEraFitMealKey,
  calculateNetCarbsFromTotalCarbs,
  parseNumberLike,
  parseNetCarbsValue,
  parseQuantity,
  readEraFitFirebasePath,
  roundNumber,
  searchEraFitFatSecretFoods,
  setEraFitFirebasePath,
  updateEraFitFirebasePath,
  type EraFitFatSecretFood,
  type EraFitFatSecretSearchFood,
  type EraFitFatSecretServing,
  type EraFitMacroTotals,
  type EraFitMealKey,
  type EraFitSession,
} from './core';
import { formatMacroNumber } from './macroFormat';
import { findSavedFoodFromCache, savedFoodSourceLabel, searchSavedFoods, type SavedFoodSearchItem } from './savedFoods';

const STANDARD_UNITS = ['g', 'oz', 'ml', 'fl_oz'] as const;

export type StandardUnit = (typeof STANDARD_UNITS)[number];

export interface ParsedTrackItem {
  raw: string;
  amount: number;
  unit: string | null;
  query: string;
  explicitFoodId: string | null;
}

export interface ServingChoice {
  type: 'fatsecret' | 'standard' | 'saved';
  label: string;
  description: string;
  servingId?: string;
  unit?: StandardUnit;
}

export interface TrackedFoodRecord {
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
  net_carbs?: number;
  fat: number;
  energy?: number;
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

export interface ResolvedTrackFood {
  input: ParsedTrackItem;
  food: EraFitFatSecretFood | null;
  serving: ServingChoice;
  quantity: number;
  record: TrackedFoodRecord;
}

export interface SavedTrackFood extends ResolvedTrackFood {
  id: string;
  logId: string;
}

export interface TrackedFoodEntry {
  meal: EraFitMealKey;
  id: string;
  record: TrackedFoodRecord;
}

export interface PastFoodSearchItem {
  id: string;
  dateId: string | null;
  meal: EraFitMealKey | null;
  name: string;
  brandName?: string;
  servingDescription: string;
  servingQuantity: number;
  servingUnit: string;
  calories: number;
  protein: number;
  netCarbs: number;
  fat: number;
  sortKey: string;
  record: TrackedFoodRecord;
}

export function pastFoodSearchItemFromTrackedEntry(entry: TrackedFoodEntry): PastFoodSearchItem | null {
  const raw = entry.record as TrackedFoodRecord & { title?: string };
  const name = trackedFoodRecordDisplayName(entry.record);
  if (name === 'Logged food') {
    return null;
  }
  const servingQuantity = parseNumberLike(raw.serving_qtd) ?? 1;
  const servingUnit = parseString(raw.serving_unit) ?? 'serving';
  const servingDescription = parseString(raw.serving_description) ?? `${formatNumber(servingQuantity)} ${servingUnit}`;
  const logId = raw.meal_tracking_food_log ?? entry.id;
  const macros = trackedFoodRecordMacroTotals(entry.record);
  return {
    id: logId,
    dateId: parseString(logId.match(/^(\d{7})_/)?.[1]),
    meal: entry.meal,
    name,
    brandName: parseString(raw.brand_name) ?? undefined,
    servingDescription,
    servingQuantity,
    servingUnit,
    calories: macros.calories ?? 0,
    protein: macros.protein ?? 0,
    netCarbs: macros.net_carbs ?? 0,
    fat: macros.fat ?? 0,
    sortKey: logId,
    record: entry.record,
  };
}

export function trackedFoodRecordDisplayName(record: TrackedFoodRecord): string {
  const raw = record as TrackedFoodRecord & { name?: string; title?: string; type_item?: string };
  const title = optionalFoodString(raw.title);
  const foodName = optionalFoodString(raw.food_name);
  const name = optionalFoodString(raw.name);
  return raw.type_item === 'my_meals'
    ? title ?? foodName ?? name ?? 'Logged food'
    : foodName ?? title ?? name ?? 'Logged food';
}

export function trackedFoodRecordMacroTotals(record: TrackedFoodRecord): EraFitMacroTotals {
  const raw = record as TrackedFoodRecord & { total?: unknown };
  const total = asRecord(raw.total);
  const servingQuantity = parseNumberLike(raw.serving_qtd) ?? 1;
  return {
    calories: parseMacroWithTotal(raw.calories ?? raw.energy, total?.energy ?? total?.calories, servingQuantity),
    protein: parseMacroWithTotal(raw.protein, total?.protein, servingQuantity),
    net_carbs: parseMacroWithTotal(parseNetCarbsValue(raw.net_carbs, raw.carbohydrate), parseNetCarbsValue(total?.net_carbs, total?.carbohydrate), servingQuantity),
    fat: parseMacroWithTotal(raw.fat, total?.fat, servingQuantity),
  };
}

function optionalFoodString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseMacroWithTotal(value: unknown, totalValue: unknown, servingQuantity: number): number {
  const parsed = parseNumberLike(value);
  if (parsed != null) {
    return parsed;
  }
  const parsedTotal = parseNumberLike(totalValue);
  return parsedTotal == null ? 0 : parsedTotal * servingQuantity;
}

export type TrackResultFood = ResolvedTrackFood | SavedTrackFood;

export type TrackResolutionResult =
  | { status: 'resolved'; food: ResolvedTrackFood }
  | { status: 'skip' }
  | { status: 'cancel' }
  | { status: 'needs-selection' };

export interface TrackResolveOptions {
  useCache: boolean;
  writeCache: boolean;
  interactive?: boolean;
  forceServingPrompt?: boolean;
  preferredServingDescription?: string;
  aliases?: string[];
  log?: (message: string) => void;
  lookupStart?: (query: string) => void;
  lookupEnd?: () => void;
}

type BarcodeMissAction = 'skip' | 'cancel';

export type FoodSearchChoice =
  | { type: 'saved'; saved: SavedFoodSearchItem }
  | { type: 'past'; past: PastFoodSearchItem }
  | { type: 'fatsecret'; food: EraFitFatSecretSearchFood };

export function parseTrackItem(raw: string): ParsedTrackItem {
  const parsed = tryParseTrackItem(raw);
  if (!parsed) {
    throw new Error(`Could not parse food item "${raw}". Expected count [unit] name|id, for example "50g chicken breast". Separate multiple foods with \`,\`.`);
  }
  return parsed;
}

export function tryParseTrackItem(raw: string): ParsedTrackItem | null {
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

export function isBarcodeQuery(value: string): boolean {
  return /^\d{6,}$/.test(value.trim());
}

export async function resolveTrackFood(
  session: EraFitSession,
  cache: EraFitCache,
  item: ParsedTrackItem,
  time: string,
  options: TrackResolveOptions
): Promise<TrackResolutionResult> {
  const cached = options.useCache && !item.explicitFoodId ? cache.foods[normalizeFoodCacheKey(item.query)] : null;
  if (cached) {
    const cachedItem = applyCachedServingMultiplier(item, cached);
    if (cached.servingType === 'saved') {
      const saved = await findSavedFoodFromCache(session, cached);
      if (saved) {
        return {
          status: 'resolved',
          food: buildSavedResolvedTrackFood(cachedItem, saved, time),
        };
      }
    } else {
      const food = await fetchEraFitFatSecretFood(session, cached.foodId);
      const requestedServing = cachedItem.unit ? resolveAutoServingChoice(food, cachedItem) : null;
      const serving = requestedServing ?? (!cachedItem.unit ? servingFromCache(food, cached) : null);
      if (serving) {
        const quantity = defaultQuantityForServing(cachedItem, serving, food, cachedItem.amount);
        return {
          status: 'resolved',
          food: {
            input: cachedItem,
            food,
            serving,
            quantity,
            record: buildTrackedFoodRecord(food, serving, quantity, time),
          },
        };
      }
    }
  }

  const interactive = options.interactive ?? true;
  const food = item.explicitFoodId
    ? await fetchEraFitFatSecretFood(session, item.explicitFoodId)
    : isBarcodeQuery(item.query)
      ? await resolveFoodFromBarcode(session, item, interactive, options.log)
      : await resolveFoodFromSearch(session, item, interactive, options);
  if (food === 'skip' || food === 'cancel' || food === 'needs-selection') {
    return { status: food };
  }
  return finishResolvedTrackFood(cache, item, time, options, food);
}

function applyCachedServingMultiplier(item: ParsedTrackItem, cached: CachedFoodSelection): ParsedTrackItem {
  if (!cached.servingMultiplier) {
    return item;
  }
  return {
    ...item,
    amount: item.amount * cached.servingMultiplier,
  };
}

export async function resolveTrackFoodFromSearchChoice(
  session: EraFitSession,
  cache: EraFitCache,
  item: ParsedTrackItem,
  time: string,
  choice: FoodSearchChoice,
  options: TrackResolveOptions
): Promise<TrackResolutionResult> {
  if (choice.type === 'past') {
    return resolvePastTrackFood(session, cache, item, time, choice.past, options);
  }
  const food = await resolveFoodSearchChoice(session, choice);
  return finishResolvedTrackFood(cache, item, time, {
    ...options,
    preferredServingDescription: options.preferredServingDescription ?? (
      choice.type === 'fatsecret' ? parseSearchServing(choice.food.food_description) : undefined
    ),
  }, food);
}

async function resolvePastTrackFood(
  session: EraFitSession,
  cache: EraFitCache,
  item: ParsedTrackItem,
  time: string,
  past: PastFoodSearchItem,
  options: TrackResolveOptions
): Promise<TrackResolutionResult> {
  const food = await fetchPastFatSecretFood(session, past);
  if (food) {
    return finishResolvedTrackFood(cache, item, time, {
      ...options,
      forceServingPrompt: true,
      preferredServingDescription: options.preferredServingDescription ?? past.servingDescription,
    }, food);
  }
  const interactive = options.interactive ?? true;
  if (!interactive) {
    return { status: 'needs-selection' };
  }
  const serving = await promptForPastServing(past);
  if (!serving) {
    return { status: 'cancel' };
  }
  const quantity = await promptForPastQuantity(past);
  if (quantity == null) {
    return { status: 'cancel' };
  }
  return {
    status: 'resolved',
    food: buildPastResolvedTrackFood(item, past, time, quantity),
  };
}

async function finishResolvedTrackFood(
  cache: EraFitCache,
  item: ParsedTrackItem,
  time: string,
  options: TrackResolveOptions,
  food: EraFitFatSecretFood | SavedFoodSearchItem
): Promise<TrackResolutionResult> {
  if ('source' in food) {
    if (options.writeCache) {
      const selection = cachedSelectionFromSavedFood(food);
      rememberFoodSelection(cache, item.query, selection);
      for (const alias of options.aliases ?? []) {
        rememberFoodSelection(cache, alias, selection);
      }
    }
    return {
      status: 'resolved',
      food: buildSavedResolvedTrackFood(item, food, time),
    };
  }
  const interactive = options.interactive ?? true;
  const forceServingPrompt = options.forceServingPrompt ?? (
    !item.explicitFoodId && !isBarcodeQuery(item.query) && !isExactFoodMatch(food, item.query)
  );
  const serving = await resolveServingChoice(food, item, forceServingPrompt, interactive, options.preferredServingDescription);
  if (!serving) {
    return { status: interactive ? 'cancel' : 'needs-selection' };
  }
  const quantity = forceServingPrompt
    ? interactive ? await promptForQuantity(item, serving, food) : null
    : defaultQuantityForServing(item, serving, food, item.amount);
  if (quantity == null) {
    return { status: interactive ? 'cancel' : 'needs-selection' };
  }

  if (options.writeCache && serving.type !== 'saved') {
    const selection = {
      foodId: food.food_id,
      foodName: food.food_name,
      brandName: food.brand_name,
      servingType: serving.type,
      servingId: serving.servingId,
      servingUnit: serving.unit,
      servingDescription: serving.description,
    };
    rememberFoodSelection(cache, item.query, selection);
    for (const alias of options.aliases ?? []) {
      rememberFoodSelection(cache, alias, selection);
    }
  }

  return {
    status: 'resolved',
    food: {
      input: item,
      food,
      serving,
      quantity,
      record: buildTrackedFoodRecord(food, serving, quantity, time),
    },
  };
}

function cachedSelectionFromSavedFood(saved: SavedFoodSearchItem): Omit<CachedFoodSelection, 'updatedAt'> {
  return {
    foodId: saved.foodId ?? saved.customFoodId ?? saved.id,
    foodName: saved.name,
    brandName: saved.brandName,
    servingType: 'saved',
    servingDescription: saved.servingDescription,
    servingUnit: saved.servingUnit,
    servingQuantity: saved.servingQuantity,
    savedSource: saved.source,
    savedId: saved.id,
    customFoodId: saved.customFoodId,
  };
}

export async function saveTrackedFoods(
  session: EraFitSession,
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

export async function updateTrackedFood(
  session: EraFitSession,
  options: {
    dateId: string;
    meal: EraFitMealKey;
    existing: TrackedFoodEntry;
    food: ResolvedTrackFood;
  }
): Promise<SavedTrackFood> {
  const id = options.existing.id;
  const logId = options.existing.record.meal_tracking_food_log || `${options.dateId}_${options.meal}_${id}`;
  const record = {
    ...options.food.record,
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
  await saveMealTrackingTotals(session, options.dateId);
  return {
    ...options.food,
    record,
    id,
    logId,
  };
}

export async function deleteTrackedFoods(
  session: EraFitSession,
  options: {
    dateId: string;
    foods: TrackedFoodEntry[];
  }
): Promise<void> {
  for (const food of options.foods) {
    const basePath = `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking`;
    const logId = food.record.meal_tracking_food_log || `${options.dateId}_${food.meal}_${food.id}`;
    await setEraFitFirebasePath(session, `${basePath}/data/${options.dateId}/meals/${food.meal}/foods/${food.id}`, null);
    await setEraFitFirebasePath(session, `${basePath}_food_data/${logId}`, null);
  }
  await saveMealTrackingTotals(session, options.dateId);
}

export async function fetchTrackedFoodsForDate(session: EraFitSession, dateId: string): Promise<TrackedFoodEntry[]> {
  const basePath = `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking`;
  const meals = await readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/data/${dateId}/meals`) ?? {};
  const entries: TrackedFoodEntry[] = [];
  for (const [meal, rawMeal] of Object.entries(meals)) {
    const foods = asRecord(rawMeal)?.foods;
    if (!foods || !isEraFitMealKey(meal)) {
      continue;
    }
    for (const [id, rawFood] of Object.entries(foods)) {
      const record = asRecord(rawFood);
      if (!record) {
        continue;
      }
      entries.push({
        meal,
        id,
        record: record as unknown as TrackedFoodRecord,
      });
    }
  }
  return entries;
}

export function formatEraFitTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

async function resolveFoodFromSearch(
  session: EraFitSession,
  item: ParsedTrackItem,
  interactive: boolean,
  options: Pick<TrackResolveOptions, 'lookupStart' | 'lookupEnd'>
): Promise<EraFitFatSecretFood | SavedFoodSearchItem | 'cancel' | 'needs-selection'> {
  options.lookupStart?.(item.query);
  let search: FoodSearchResults;
  try {
    search = await fetchFoodSearchResults(session, item.query);
  } finally {
    options.lookupEnd?.();
  }
  const { savedResults, fatSecretResults, choices: results } = search;
  const exactSavedMatches = savedResults.filter(result => normalizeFoodCacheKey(result.name) === normalizeFoodCacheKey(item.query));
  if (exactSavedMatches.length === 1) {
    return exactSavedMatches[0];
  }

  if (results.length === 0) {
    if (!interactive) {
      return 'needs-selection';
    }
    throw new Error(`No Era Fit food results for "${item.query}".`);
  }

  const exactMatches = fatSecretResults.filter(result => normalizeFoodCacheKey(result.food_name) === normalizeFoodCacheKey(item.query));
  if (savedResults.length === 0 && exactMatches.length === 1) {
    const food = await fetchEraFitFatSecretFood(session, exactMatches[0].food_id);
    if (resolveAutoServingChoice(food, item)) {
      return food;
    }
  }
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return 'needs-selection';
  }

  const labels = formatFoodSearchOptionLabels(results);
  const selected = await select({
    message: `Select food for ${item.raw}`,
    options: results.map((result, index) => ({
      value: String(index),
      label: labels[index],
    })),
  });
  if (isCancel(selected)) {
    return 'cancel';
  }
  const choice = results[Number(selected)];
  if (!choice) {
    return 'cancel';
  }
  return resolveFoodSearchChoice(session, choice);
}

interface FoodSearchResults {
  savedResults: SavedFoodSearchItem[];
  fatSecretResults: EraFitFatSecretSearchFood[];
  choices: FoodSearchChoice[];
}

export async function searchTrackFoodChoices(session: EraFitSession, item: ParsedTrackItem): Promise<FoodSearchChoice[]> {
  return (await fetchFoodSearchResults(session, item.query)).choices;
}

async function fetchFoodSearchResults(session: EraFitSession, query: string): Promise<FoodSearchResults> {
  const [savedResults, fatSecretResults] = await Promise.all([
    searchSavedFoods(session, query),
    searchEraFitFatSecretFoods(session, query),
  ]);
  const savedFoodIds = new Set(savedResults.map(result => result.foodId).filter((value): value is string => !!value));
  return {
    savedResults,
    fatSecretResults,
    choices: [
      ...savedResults.map(saved => ({ type: 'saved' as const, saved })),
      ...fatSecretResults
        .filter(food => !savedFoodIds.has(food.food_id))
        .map(food => ({ type: 'fatsecret' as const, food })),
    ].slice(0, 10),
  };
}

async function resolveFoodSearchChoice(
  session: EraFitSession,
  choice: FoodSearchChoice
): Promise<EraFitFatSecretFood | SavedFoodSearchItem> {
  if (choice.type === 'saved') {
    return choice.saved;
  }
  if (choice.type === 'fatsecret') {
    return fetchEraFitFatSecretFood(session, choice.food.food_id);
  }
  throw new Error(`Cannot fetch details for ${choice.past.name}.`);
}

async function fetchPastFatSecretFood(session: EraFitSession, past: PastFoodSearchItem): Promise<EraFitFatSecretFood | null> {
  const record = past.record as TrackedFoodRecord & { type_item?: string; food_customized_id?: string };
  if (
    !record.food_id ||
    record.food_customized_id ||
    record.type_item === 'food_customized' ||
    record.type_item === 'my_meals' ||
    record.food_type === 'my_meals'
  ) {
    return null;
  }
  return await fetchEraFitFatSecretFood(session, record.food_id).catch(() => null);
}

async function resolveFoodFromBarcode(
  session: EraFitSession,
  item: ParsedTrackItem,
  interactive: boolean,
  log?: (message: string) => void
): Promise<EraFitFatSecretFood | BarcodeMissAction> {
  const food = await fetchEraFitFatSecretFoodByBarcode(session, item.query);
  if (food) {
    return food;
  }
  log?.(`${chalk.yellow('barcode not found')} ${chalk.cyan(item.query)}`);
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`No Era Fit food found for barcode ${item.query}.`);
  }
  const action = await select({
    message: `No food found for barcode ${item.query}`,
    options: [
      { value: 'skip', label: 'Skip this item' },
      { value: 'cancel', label: 'Cancel tracking' },
    ],
  });
  if (isCancel(action)) {
    return 'cancel';
  }
  return action;
}

export function formatFoodSearchOptionLabels(results: FoodSearchChoice[]): string[] {
  const availableWidth = Math.max(60, (process.stdout.columns || 100) - 8);
  const servingWidth = availableWidth < 92 ? 14 : 18;
  const nameWidth = Math.max(24, Math.min(44, availableWidth - servingWidth - 32));
  return formatTabularRows(results.map(result => {
    const macros = foodSearchChoiceMacroTotals(result);
    return [
      formatFoodSearchChoiceName(result),
      `per ${formatFoodSearchChoiceServing(result)}`,
      formatSearchMacro(macros.calories, 'cal'),
      formatSearchMacro(macros.protein, 'p'),
      formatSearchMacro(macros.net_carbs, 'c'),
      formatSearchMacro(macros.fat, 'f'),
    ];
  }), {
    gap: '  ',
    columns: [
      { maxWidth: nameWidth },
      { maxWidth: servingWidth },
      { align: 'right' },
      { align: 'right' },
      { align: 'right' },
      { align: 'right' },
    ],
  });
}

export function formatFoodSearchChoiceName(result: FoodSearchChoice): string {
  if (result.type === 'saved') {
    const suffix = result.saved.brandName ? ` by ${result.saved.brandName}` : ` [${savedFoodSourceLabel(result.saved.source)}]`;
    return `${chalk.yellow('★')} ${result.saved.name}${suffix}`;
  }
  if (result.type === 'past') {
    const suffix = result.past.brandName ? ` by ${result.past.brandName}` : '';
    return `${chalk.cyan('↺')} ${result.past.name}${suffix}`;
  }
  return result.food.brand_name ? `${result.food.food_name} by ${result.food.brand_name}` : result.food.food_name;
}

export function formatFoodSearchChoiceServing(result: FoodSearchChoice): string {
  const value = result.type === 'saved'
    ? result.saved.servingDescription
    : result.type === 'past'
      ? result.past.servingDescription
      : parseSearchServing(result.food.food_description);
  return value.replace(/^Per\s+/i, '').trim();
}

export function foodSearchChoiceMacroTotals(result: FoodSearchChoice): EraFitMacroTotals {
  if (result.type === 'saved') {
    return {
      calories: result.saved.calories,
      protein: result.saved.protein,
      net_carbs: result.saved.carbohydrate,
      fat: result.saved.fat,
    };
  }
  if (result.type === 'past') {
    return {
      calories: result.past.calories,
      protein: result.past.protein,
      net_carbs: result.past.netCarbs,
      fat: result.past.fat,
    };
  }
  return parseSearchMacros(result.food.food_description);
}

function formatSearchMacro(value: number | null, suffix: string): string {
  return value == null ? `-${suffix}` : `${formatMacroNumber(value)}${suffix}`;
}

async function resolveServingChoice(
  food: EraFitFatSecretFood,
  item: ParsedTrackItem,
  forcePrompt: boolean,
  interactive: boolean,
  preferredServingDescription?: string
): Promise<ServingChoice | null> {
  const auto = resolveAutoServingChoice(food, item) ?? resolvePreferredServingChoice(food, preferredServingDescription);
  if (auto && !forcePrompt) {
    return auto;
  }
  if (!interactive) {
    return null;
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
    return null;
  }
  return choices[Number(selected)];
}

function resolvePreferredServingChoice(
  food: EraFitFatSecretFood,
  preferredServingDescription: string | undefined
): ServingChoice | null {
  const normalized = normalizeServingDescription(preferredServingDescription);
  if (!normalized) {
    return null;
  }
  const match = Object.values(food.servings).find(serving => {
    const servingDescription = normalizeServingDescription(serving.serving_description);
    return servingDescription === normalized ||
      servingDescription.includes(normalized) ||
      normalized.includes(servingDescription);
  });
  if (!match) {
    return null;
  }
  return {
    type: 'fatsecret',
    servingId: match.serving_id,
    label: match.serving_description,
    description: match.serving_description,
  };
}

function normalizeServingDescription(value: string | undefined): string {
  return value
    ?.toLowerCase()
    .replace(/^per\s+/i, '')
    .replace(/(\d)\s+(g|oz|ml|tbsp|tsp|cup|cups|serving|servings)\b/g, '$1$2')
    .replace(/[^a-z0-9%.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ') ?? '';
}

async function promptForQuantity(
  item: ParsedTrackItem,
  serving: ServingChoice,
  food: EraFitFatSecretFood
): Promise<number | null> {
  const initialValue = formatNumber(defaultQuantityForServing(item, serving, food, item.amount));
  return await promptForQuantityWithPreview({
    message: `Amount for ${serving.description}`,
    initialValue,
    preview: quantity => formatQuantityMacroPreview(trackedFoodRecordMacroTotals(
      buildTrackedFoodRecord(food, serving, quantity, '')
    )),
  });
}

async function promptForPastServing(past: PastFoodSearchItem): Promise<ServingChoice | null> {
  const description = basePastServingDescription(past);
  const value = await select({
    message: `Select serving for ${past.name}`,
    options: [
      {
        value: 'past',
        label: description,
      },
    ],
    initialValue: 'past',
  });
  if (isCancel(value)) {
    return null;
  }
  return {
    type: 'saved',
    label: description,
    description,
  };
}

async function promptForPastQuantity(past: PastFoodSearchItem): Promise<number | null> {
  const initialValue = formatNumber(past.servingQuantity > 0 ? past.servingQuantity : 1);
  return await promptForQuantityWithPreview({
    message: `Amount for ${basePastServingDescription(past)}`,
    initialValue,
    preview: quantity => formatQuantityMacroPreview(trackedFoodRecordMacroTotals({
      ...scalePastFoodRecord(past.record, quantity),
      serving_qtd: quantity,
    })),
  });
}

async function promptForQuantityWithPreview(options: {
  message: string;
  initialValue: string;
  preview: (quantity: number) => string;
}): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const value = await text({
      message: `${options.message} ${options.preview(parseQuantity(options.initialValue) ?? 1)}`,
      initialValue: options.initialValue,
      validate(input) {
        const parsed = parseQuantity(input?.trim() ?? '');
        return parsed != null && parsed > 0 ? undefined : 'Enter a positive number.';
      },
    });
    if (isCancel(value)) {
      return null;
    }
    return parseQuantity(value.trim()) ?? Number(options.initialValue);
  }

  return await new Promise<number | null>(resolve => {
    const input = process.stdin;
    const output = process.stdout;
    const rawModeWasEnabled = input.isRaw;
    let value = options.initialValue;
    let error: string | null = null;
    let settled = false;

    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (input.setRawMode) {
        input.setRawMode(rawModeWasEnabled);
      }
      output.write('\n');
    };
    const finish = (result: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const render = () => {
      const parsed = parseQuantity(value.trim());
      const preview = parsed != null && parsed > 0 ? options.preview(parsed) : chalk.gray('enter a positive number');
      const suffix = error ? ` ${chalk.red(error)}` : '';
      output.write(`\r\x1b[2K${chalk.cyan('◇')} ${options.message}: ${value}${chalk.gray('  ')}${preview}${suffix}`);
    };
    const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }
      if (key.name === 'escape') {
        finish(null);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const parsed = parseQuantity(value.trim());
        if (parsed != null && parsed > 0) {
          finish(parsed);
          return;
        }
        error = 'Enter a positive number.';
        render();
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1);
        error = null;
        render();
        return;
      }
      if (key.ctrl && key.name === 'u') {
        value = '';
        error = null;
        render();
        return;
      }
      if (!key.ctrl && !key.meta && character && /^[\d./ ]$/.test(character)) {
        value += character;
        error = null;
        render();
      }
    };

    emitKeypressEvents(input);
    input.on('keypress', onKeypress);
    input.setRawMode?.(true);
    input.resume();
    render();
  });
}

function basePastServingDescription(past: PastFoodSearchItem): string {
  if (past.servingUnit !== 'fatsecret') {
    return `1 ${formatServingUnitForDisplay(singularServingUnit(past.servingUnit))}`;
  }
  return past.servingDescription;
}

function singularServingUnit(unit: string): string {
  const normalized = unit.trim();
  return normalized.toLowerCase() === 'servings' ? 'serving' : normalized;
}

function formatQuantityMacroPreview(macros: EraFitMacroTotals): string {
  return [
    `${chalk.blue(formatMacroNumber(macros.calories ?? 0))} cal`,
    `P ${chalk.red(formatMacroNumber(macros.protein ?? 0))}`,
    `C ${chalk.yellow(formatMacroNumber(macros.net_carbs ?? 0))}`,
    `F ${chalk.cyan(formatMacroNumber(macros.fat ?? 0))}`,
  ].join(chalk.gray(' | '));
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

function buildSavedResolvedTrackFood(item: ParsedTrackItem, saved: SavedFoodSearchItem, time: string): ResolvedTrackFood {
  const quantity = saved.source === 'my_meal'
    ? item.amount
    : resolveSavedServingUsage(item, saved).quantity;
  return {
    input: item,
    food: null,
    serving: {
      type: 'saved',
      label: saved.servingDescription,
      description: saved.servingDescription,
    },
    quantity,
    record: saved.source === 'my_meal'
      ? buildSavedMealRecord(saved, item.amount, time)
      : buildSavedFoodRecord(saved, item, time),
  };
}

function buildPastResolvedTrackFood(
  item: ParsedTrackItem,
  past: PastFoodSearchItem,
  time: string,
  quantity: number
): ResolvedTrackFood {
  return {
    input: item,
    food: null,
    serving: {
      type: 'saved',
      label: past.servingDescription,
      description: past.servingDescription,
    },
    quantity,
    record: cleanFoodRecord({
      ...scalePastFoodRecord(past.record, quantity),
      serving_qtd: quantity,
      serving_description: formatPastServingDescription(past, quantity),
      time,
    } as unknown as TrackedFoodRecord),
  };
}

function scalePastFoodRecord(record: TrackedFoodRecord, quantity: number): TrackedFoodRecord {
  const baseQuantity = parseNumberLike(record.serving_qtd) ?? 1;
  const factor = baseQuantity > 0 ? quantity / baseQuantity : 1;
  const scaled = { ...record } as Record<string, unknown>;
  const macros = trackedFoodRecordMacroTotals(record);
  if (parseNumberLike(scaled.calories) == null && parseNumberLike(scaled.energy) == null) {
    scaled.calories = macros.calories;
  }
  if (parseNumberLike(scaled.protein) == null) {
    scaled.protein = macros.protein;
  }
  if (parseNetCarbsValue(scaled.net_carbs, scaled.carbohydrate) == null) {
    scaled.net_carbs = macros.net_carbs;
    scaled.carbohydrate = macros.net_carbs;
  }
  if (parseNumberLike(scaled.fat) == null) {
    scaled.fat = macros.fat;
  }
  const fields = [
    'calories',
    'energy',
    'protein',
    'carbohydrate',
    'net_carbs',
    'fat',
    'saturated_fat',
    'trans_fat',
    'polyunsaturated_fat',
    'monounsaturated_fat',
    'cholesterol',
    'sodium',
    'potassium',
    'fiber',
    'sugar',
    'vitamin_a',
    'vitamin_c',
    'vitamin_d',
    'calcium',
    'iron',
  ] as const;
  for (const field of fields) {
    const value = parseNumberLike(scaled[field]);
    if (value != null) {
      scaled[field] = roundNumber(value * factor);
    }
  }
  scaled.ef_version = 1;
  return scaled as unknown as TrackedFoodRecord;
}

function formatPastServingDescription(past: PastFoodSearchItem, quantity: number): string {
  const unit = past.servingUnit === 'fatsecret' ? null : past.servingUnit;
  return unit ? `${formatNumber(quantity)} ${formatServingUnitForDisplay(unit)}` : past.servingDescription;
}

function buildSavedMealRecord(saved: SavedFoodSearchItem, quantity: number, time: string): TrackedFoodRecord {
  return cleanFoodRecord({
    ...saved.raw,
    food_id: saved.id,
    food_name: saved.name,
    food_type: 'my_meals',
    brand_name: '',
    title: saved.name,
    type_item: 'my_meals',
    serving_qtd: quantity,
    serving_unit: 'serving',
    serving_description: `${formatNumber(quantity)} serving${Math.abs(quantity - 1) < 0.0001 ? '' : 's'}`,
    calories: saved.calories * quantity,
    protein: saved.protein * quantity,
    carbohydrate: saved.carbohydrate * quantity,
    net_carbs: saved.carbohydrate * quantity,
    fat: saved.fat * quantity,
    time,
  } as unknown as TrackedFoodRecord);
}

function buildSavedFoodRecord(saved: SavedFoodSearchItem, item: ParsedTrackItem, time: string): TrackedFoodRecord {
  const usage = resolveSavedServingUsage(item, saved);
  const sourceRecord: Record<string, unknown> = {
    ...saved.raw,
    food_id: saved.foodId ?? saved.customFoodId ?? saved.id,
    food_name: saved.name,
    brand_name: saved.brandName ?? '',
    food_type: parseString(saved.raw.food_type) ?? savedFoodSourceLabel(saved.source),
  };
  if (saved.source === 'custom_food' || saved.customFoodId) {
    sourceRecord.type_item = 'food_customized';
    sourceRecord.food_customized_id = saved.customFoodId ?? saved.id;
  }
  return cleanFoodRecord({
    ...sourceRecord,
    ef_version: 1,
    serving_qtd: usage.quantity,
    serving_unit: usage.unit,
    serving_description: usage.description,
    calories: saved.calories * usage.factor,
    protein: saved.protein * usage.factor,
    carbohydrate: saved.carbohydrate * usage.factor,
    net_carbs: saved.carbohydrate * usage.factor,
    fat: saved.fat * usage.factor,
    saturated_fat: numeric(saved.raw.saturated_fat) * usage.factor,
    trans_fat: numeric(saved.raw.trans_fat) * usage.factor,
    polyunsaturated_fat: numeric(saved.raw.polyunsaturated_fat) * usage.factor,
    monounsaturated_fat: numeric(saved.raw.monounsaturated_fat) * usage.factor,
    cholesterol: numeric(saved.raw.cholesterol) * usage.factor,
    sodium: numeric(saved.raw.sodium) * usage.factor,
    potassium: numeric(saved.raw.potassium) * usage.factor,
    fiber: numeric(saved.raw.fiber) * usage.factor,
    sugar: numeric(saved.raw.sugar) * usage.factor,
    vitamin_a: numeric(saved.raw.vitamin_a) * usage.factor,
    vitamin_c: numeric(saved.raw.vitamin_c) * usage.factor,
    vitamin_d: numeric(saved.raw.vitamin_d) * usage.factor,
    calcium: numeric(saved.raw.calcium) * usage.factor,
    iron: numeric(saved.raw.iron) * usage.factor,
    time,
  } as unknown as TrackedFoodRecord);
}

function resolveSavedServingUsage(item: ParsedTrackItem, saved: SavedFoodSearchItem): {
  quantity: number;
  unit: string;
  description: string;
  factor: number;
} {
  const requestedUnit = parseStandardUnit(item.unit);
  const savedUnit = parseStandardUnit(saved.servingUnit);
  if (requestedUnit && savedUnit) {
    const converted = convertStandardAmount(item.amount, requestedUnit, savedUnit);
    if (converted != null && saved.servingQuantity > 0) {
      return {
        quantity: item.amount,
        unit: requestedUnit,
        description: `${formatNumber(item.amount)} ${requestedUnit}`,
        factor: converted / saved.servingQuantity,
      };
    }
  }

  if (item.unit && normalizeServingUnit(item.unit) === normalizeServingUnit(saved.servingUnit) && saved.servingQuantity > 0) {
    return {
      quantity: item.amount,
      unit: saved.servingUnit,
      description: `${formatNumber(item.amount)} ${formatServingUnitForDisplay(saved.servingUnit)}`,
      factor: item.amount / saved.servingQuantity,
    };
  }

  const factor = item.amount;
  const quantity = saved.servingQuantity * factor;
  return {
    quantity,
    unit: saved.servingUnit,
    description: `${formatNumber(quantity)} ${formatServingUnitForDisplay(saved.servingUnit)}`,
    factor,
  };
}

async function saveMealTrackingTotals(session: EraFitSession, dateId: string): Promise<void> {
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
    net_carbs: (parseNetCarbsValue(food.net_carbs, food.carbohydrate) ?? 0) * multiplier,
    fat: (parseNumberLike(food.fat) ?? 0) * multiplier,
    energy: (parseNumberLike(food.energy) ?? parseNumberLike(food.calories) ?? 0) * multiplier,
  };
}

function calculateFatSecretServing(
  serving: EraFitFatSecretServing,
  quantity: number,
  foodInfo: Pick<TrackedFoodRecord, 'food_id' | 'food_name' | 'food_type' | 'food_url' | 'brand_name'>
): TrackedFoodRecord {
  const netCarbs = calculateNetCarbsFromTotalCarbs(serving.carbohydrate, serving.fiber) ?? 0;
  return {
    ...foodInfo,
    serving_qtd: quantity,
    serving_unit: 'fatsecret',
    serving_id: serving.serving_id,
    serving_description: serving.serving_description,
    calories: numeric(serving.calories) * quantity,
    protein: numeric(serving.protein) * quantity,
    carbohydrate: netCarbs * quantity,
    net_carbs: netCarbs * quantity,
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
    net_carbs: (perUnit.net_carbs ?? perUnit.carbohydrate) * baseAmount,
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

function normalizeServingUnit(value: string | null | undefined): string {
  return value?.toLowerCase().replaceAll(/[_\s]+/g, ' ').replace(/s$/, '') ?? '';
}

function formatServingUnitForDisplay(value: string): string {
  return value.replaceAll('_', ' ');
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

function parseSearchMacros(description: string): EraFitMacroTotals {
  const carbs = parseNumberLike(description.match(/Carbs:\s*([\d.]+)/i)?.[1]);
  const fiber = parseNumberLike(description.match(/Fiber:\s*([\d.]+)/i)?.[1]);
  return {
    calories: parseNumberLike(description.match(/Calories:\s*([\d.]+)/i)?.[1]),
    protein: parseNumberLike(description.match(/Protein:\s*([\d.]+)/i)?.[1]),
    net_carbs: calculateNetCarbsFromTotalCarbs(carbs, fiber),
    fat: parseNumberLike(description.match(/Fat:\s*([\d.]+)/i)?.[1]),
  };
}

function numeric(value: unknown): number {
  return parseNumberLike(value) ?? 0;
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function generateNutritionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 20);
}
