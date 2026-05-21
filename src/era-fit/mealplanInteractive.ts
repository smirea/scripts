import { createInterface, emitKeypressEvents, type Interface, type Key } from 'node:readline';

import { isCancel as isPromptCancel, text } from '@clack/prompts';
import chalk from 'chalk';

import { padVisibleEnd, padVisibleStart, truncateVisibleEnd, visibleLength } from '../utils/tabular';
import {
  normalizeFoodCacheKey,
  rememberFoodSelection,
  type CachedFoodSelection,
  type EraFitCache,
} from './cache';
import {
  formatDateKey,
  formatEraFitDateId,
  formatNumber,
  parseNumberLike,
  parseNetCarbsValue,
  roundNumber,
  searchEraFitFatSecretFoods,
  startOfLocalDay,
  uniqueStrings,
  type EraFitMacroTotals,
  type EraFitMealKey,
  type EraFitMealPlanDay,
  type EraFitMealPlanFoodItem,
  type EraFitMealPlanMeal,
  type EraFitSession,
} from './core';
import { formatMacroColumns, formatMacroNumber, getMacroColumnWidths, type MacroColumnWidths } from './macroFormat';
import {
  deleteTrackedFoods,
  fetchTrackedFoodsForDate,
  foodSearchChoiceMacroTotals,
  formatEraFitTime,
  formatFoodSearchChoiceName,
  formatFoodSearchChoiceServing,
  parseTrackItem,
  pastFoodSearchItemFromTrackedEntry,
  formatFoodSearchOptionLabels,
  resolveTrackFood,
  resolveTrackFoodFromSearchChoice,
  saveTrackedFoods,
  searchTrackFoodChoices,
  tryParseTrackItem,
  type FoodSearchChoice,
  type PastFoodSearchItem,
  type ParsedTrackItem,
  type ResolvedTrackFood,
  type SavedTrackFood,
  type TrackedFoodEntry,
  type TrackedFoodRecord,
  updateTrackedFood,
} from './tracking';
import { listPastTrackedFoods, searchPastTrackedFoods } from './historyFoods';
import { listSavedFoods, type SavedFoodSearchItem, type SavedFoodSource } from './savedFoods';

type NavigationMode = 'meals' | 'items' | 'assign' | 'food-search' | 'add';
type LoadingKind = 'checking' | 'unchecking';
type AddFoodTab = 'search' | 'past' | 'faves' | 'meals' | 'food';

const CHECKBOX_EMPTY = '○';
const CHECKBOX_CHECKED = '×';
const CHECKBOX_PARTIAL = '⊝';
const OUTSIDE_PLAN_CHECKED = '✔';
const ASSIGN_POINTER = '↣';
const EXPAND_COLLAPSED = '⊞';
const EXPAND_EXPANDED = '⊟';
const ITEM_ROW_PREFIX_WIDTH = visibleLength(`  > ${EXPAND_COLLAPSED} ${CHECKBOX_EMPTY} `);
const LOADING_FRAMES = ['◐', '◓', '◑', '◒'];
const KEYPRESS_ESCAPE_TIMEOUT_MS = 25;
let keypressEventsEnabled = false;
let keypressInterface: Interface | null = null;

interface InteractiveMealPlanOptions {
  session: EraFitSession;
  cache: EraFitCache;
  day: EraFitMealPlanDay;
  dryRun: boolean;
}

interface MealPlanItemRef {
  key: string;
  mealIndex: number;
  itemIndex: number;
  meal: EraFitMealPlanMeal;
  trackingMeal: EraFitMealKey;
  item: EraFitMealPlanFoodItem;
}

interface OutsidePlanItemRef {
  key: string;
  mealIndex: number;
  trackingMeal: EraFitMealKey;
  entry: TrackedFoodEntry;
}

type MealPlanRowRef =
  | { type: 'plan'; item: MealPlanItemRef }
  | { type: 'outside'; item: OutsidePlanItemRef };

interface FoodSearchState {
  item: MealPlanItemRef;
  trackItem: ParsedTrackItem;
  query: string;
  choices: FoodSearchChoice[];
  labels: string[];
  cursor: number;
  loading: boolean;
  requestId: number;
}

interface AddFoodState {
  mealIndex: number;
  tab: AddFoodTab;
  query: string;
  choices: FoodSearchChoice[];
  cursor: number;
  loading: boolean;
  requestId: number;
  pastFoods: PastFoodSearchItem[] | null;
  savedFoods: SavedFoodSearchItem[] | null;
}

interface InteractiveState {
  day: EraFitMealPlanDay;
  meals: Array<{
    meal: EraFitMealPlanMeal;
    trackingMeal: EraFitMealKey;
    items: MealPlanItemRef[];
    outsideItems: OutsidePlanItemRef[];
  }>;
  dryRun: boolean;
  mode: NavigationMode;
  mealCursor: number;
  itemCursor: number;
  assignSource: OutsidePlanItemRef | null;
  completedItemKeys: Set<string>;
  existingItemKeys: Set<string>;
  trackedItemByKey: Map<string, TrackedFoodEntry>;
  trackedEntries: TrackedFoodEntry[];
  loadingItemKeys: Map<string, LoadingKind>;
  tasks: Set<Promise<void>>;
  multipliers: Map<string, number>;
  pendingSearchItems: MealPlanItemRef[];
  foodSearch: FoodSearchState | null;
  addFood: AddFoodState | null;
  expandedItemKey: string | null;
  originalMealIndex: number | null;
  renderCache: InteractiveRenderCache;
  messages: string[];
}

interface IngredientLineLayout {
  labelWidth: number;
  macroWidths: MacroColumnWidths;
}

interface InteractiveRenderCache {
  ingredientLayout: IngredientLineLayout | null;
  trackedComponents: Map<string, EraFitMealPlanFoodItem[]>;
  trackedMacroTotals: Map<string, EraFitMealPlanFoodItem>;
}

type MealPlanPromptAction =
  | { type: 'toggle-meal'; mealIndex: number }
  | { type: 'toggle-row'; mealIndex: number; rowIndex: number }
  | { type: 'set-serving'; mealIndex: number; rowIndex: number }
  | { type: 'edit-serving'; mealIndex: number; rowIndex: number }
  | { type: 'open-food-search'; mealIndex: number; rowIndex: number; query?: string }
  | { type: 'select-food-search'; index: number }
  | { type: 'cancel-food-search' }
  | { type: 'select-add-food'; index: number }
  | { type: 'done' };

export async function runInteractiveTodayMealPlan(options: InteractiveMealPlanOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive mealplan mode requires a TTY. Use --format=json or omit --today for noninteractive output.');
  }

  const date = startOfLocalDay(new Date());
  const dateId = formatEraFitDateId(date);
  const tracked = await fetchTrackedFoodsForDate(options.session, dateId);
  const state = createInteractiveState(options.day, options.cache, tracked, options.dryRun);
  clearInteractiveScreen();
  if (options.dryRun) {
    pushMessage(state, `dry run for ${formatDateKey(date)}; no Era Fit writes or cache updates`);
  }

  while (true) {
    clearInteractiveScreen();
    const action = await promptMealPlanChecklist(options.session, options.cache, state);
    if (!action || action.type === 'done') {
      if (state.tasks.size > 0) {
        process.stdout.write(chalk.gray(`waiting for ${state.tasks.size} pending update${state.tasks.size === 1 ? '' : 's'}...\n`));
        await Promise.allSettled(Array.from(state.tasks));
      }
      clearInteractiveScreen();
      process.stdout.write(chalk.gray('done\n'));
      return;
    }
    await handleMealPlanAction(options.session, options.cache, dateId, state, action);
  }
}

async function promptMealPlanChecklist(
  session: EraFitSession,
  cache: EraFitCache,
  state: InteractiveState
): Promise<MealPlanPromptAction | undefined> {
  return await new MealPlanChecklistPrompt(session, cache, state).prompt();
}

function createInteractiveState(
  day: EraFitMealPlanDay,
  cache: EraFitCache,
  tracked: TrackedFoodEntry[],
  dryRun: boolean
): InteractiveState {
  const meals: InteractiveState['meals'] = day.meals.map((meal, mealIndex) => {
    const trackingMeal = resolveTrackingMeal(cache, meal);
    return {
      meal,
      trackingMeal,
      items: meal.items.map((item, itemIndex) => ({
        key: `${meal.meal_key}:${itemIndex}:${item.description ?? item.name}`,
        mealIndex,
        itemIndex,
        meal,
        trackingMeal,
        item,
      })),
      outsideItems: [],
    };
  });
  const matched = matchExistingTrackedItems(cache, meals, tracked);
  for (const [mealIndex, meal] of meals.entries()) {
    meal.outsideItems = matched.outsideByMeal.get(meal.trackingMeal)?.map((entry, outsideIndex) => ({
      key: `${meal.trackingMeal}:outside:${entry.id}:${outsideIndex}`,
      mealIndex,
      trackingMeal: meal.trackingMeal,
      entry,
    })) ?? [];
  }
  return {
    day,
    meals,
    dryRun,
    mode: 'meals',
    mealCursor: 0,
    itemCursor: 0,
    assignSource: null,
    completedItemKeys: matched.completed,
    existingItemKeys: new Set(matched.completed),
    trackedItemByKey: matched.trackedByItemKey,
    trackedEntries: [...tracked],
    loadingItemKeys: new Map(),
    tasks: new Set(),
    multipliers: new Map(),
    pendingSearchItems: [],
    foodSearch: null,
    addFood: null,
    expandedItemKey: null,
    originalMealIndex: null,
    renderCache: createRenderCache(),
    messages: [],
  };
}

function createRenderCache(): InteractiveRenderCache {
  return {
    ingredientLayout: null,
    trackedComponents: new Map(),
    trackedMacroTotals: new Map(),
  };
}

function invalidateRenderCache(state: InteractiveState): void {
  state.renderCache = createRenderCache();
}

function resolveTrackingMeal(cache: EraFitCache, meal: EraFitMealPlanMeal): EraFitMealKey {
  const mapped = cache.mealPlanMealMap[meal.meal_key];
  if (!mapped) {
    throw new Error(`No mealPlanMealMap entry for "${meal.meal_key}" in src/era-fit/cache.json.`);
  }
  return mapped;
}

async function handleMealPlanAction(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  action: MealPlanPromptAction
): Promise<void> {
  state.expandedItemKey = null;
  state.originalMealIndex = null;
  invalidateRenderCache(state);
  if (action.type === 'toggle-meal') {
    const meal = state.meals[action.mealIndex];
    startToggleItemsTask(session, cache, dateId, state, meal.items);
    return;
  }
  if (action.type === 'done') {
    return;
  }
  if (action.type === 'cancel-food-search') {
    closeFoodSearch(state);
    return;
  }
  if (action.type === 'select-food-search') {
    await logSelectedFoodSearchChoice(session, cache, dateId, state, action.index);
    return;
  }
  if (action.type === 'select-add-food') {
    await logSelectedAddFoodChoice(session, cache, dateId, state, action.index);
    return;
  }
  const row = getMealRow(state, action.mealIndex, action.rowIndex);
  if (action.type === 'toggle-row') {
    if (row?.type === 'plan') {
      startToggleItemsTask(session, cache, dateId, state, [row.item]);
    } else if (row?.type === 'outside') {
      pushMessage(state, 'logged outside plan; press A to assign it');
    }
    return;
  }
  if (action.type === 'edit-serving') {
    clearInteractiveScreen();
    if (row) {
      await editTrackedRowServing(session, cache, dateId, state, row);
    }
    return;
  }
  if (row?.type !== 'plan') {
    return;
  }
  clearInteractiveScreen();
  if (action.type === 'open-food-search') {
    await openFoodSearch(session, state, row.item, action.query ?? row.item.item.name);
    return;
  }
  if (action.type === 'set-serving') {
    await promptServingMultiplier(state, row.item);
    return;
  }
  await openFoodSearch(session, state, row.item, row.item.item.name);
}

function startToggleItemsTask(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  items: MealPlanItemRef[]
): void {
  const available = items.filter(item => !state.loadingItemKeys.has(item.key));
  if (available.length === 0) {
    pushMessage(state, 'selection is already updating');
    return;
  }
  const shouldUncheck = available.every(item => state.completedItemKeys.has(item.key));
  const targets = shouldUncheck
    ? available.filter(item => state.completedItemKeys.has(item.key))
    : available.filter(item => !state.completedItemKeys.has(item.key));
  if (targets.length === 0) {
    return;
  }

  for (const item of targets) {
    state.loadingItemKeys.set(item.key, shouldUncheck ? 'unchecking' : 'checking');
  }

  let task!: Promise<void>;
  task = (async () => {
    try {
      if (shouldUncheck) {
        await uncheckMealItems(session, dateId, state, targets);
      } else {
        await logMealItems(session, cache, dateId, state, targets, {
          interactive: false,
        });
      }
    } catch (error) {
      pushMessage(state, error instanceof Error ? error.message : String(error));
    } finally {
      for (const item of targets) {
        state.loadingItemKeys.delete(item.key);
      }
      state.tasks.delete(task);
    }
  })();
  state.tasks.add(task);
}

async function promptServingMultiplier(state: InteractiveState, item: MealPlanItemRef): Promise<void> {
  const initialValue = formatNumber(state.multipliers.get(item.key) ?? 1);
  const value = await text({
    message: `Serving multiplier for ${formatItemDisplayName(item.item)}`,
    placeholder: initialValue,
    validate(input) {
      const parsed = parseNumberLike(input);
      return parsed != null && parsed > 0 ? undefined : 'Enter a positive number.';
    },
  });
  if (isPromptCancel(value)) {
    state.mode = 'items';
    pushMessage(state, 'serving unchanged');
    return;
  }
  const multiplier = parseNumberLike(value);
  if (multiplier == null || multiplier <= 0) {
    return;
  }
  if (Math.abs(multiplier - 1) < 0.0001) {
    state.multipliers.delete(item.key);
  } else {
    state.multipliers.set(item.key, multiplier);
  }
  invalidateRenderCache(state);
  pushMessage(state, `${formatItemDisplayName(item.item)} multiplier set to ${formatNumber(multiplier)}x`);
  state.mode = 'items';
}

async function openFoodSearch(
  session: EraFitSession,
  state: InteractiveState,
  item: MealPlanItemRef,
  query: string
): Promise<void> {
  if (state.completedItemKeys.has(item.key)) {
    pushMessage(state, `${formatItemDisplayName(item.item)} is already checked`);
    return;
  }
  const trackItem = buildReplacementTrackItem(item, query, state.multipliers.get(item.key) ?? 1);
  state.mode = 'food-search';
  state.mealCursor = item.mealIndex;
  state.itemCursor = itemRowIndex(state, item);
  state.loadingItemKeys.set(item.key, 'checking');
  state.foodSearch = {
    item,
    trackItem,
    query: trackItem.query,
    choices: [],
    labels: [],
    cursor: 0,
    loading: true,
    requestId: 0,
  };
  const repaint = () => {
    clearInteractiveScreen();
    process.stdout.write(renderMealPlanFrame(state));
  };
  repaint();
  const timer = setInterval(repaint, 120);
  try {
    const choices = await searchTrackFoodChoices(session, trackItem);
    if (choices.length === 0) {
      closeFoodSearch(state);
      pushMessage(state, `no results for ${trackItem.query}`);
      return;
    }
    state.foodSearch = {
      item,
      trackItem,
      query: trackItem.query,
      choices,
      labels: formatFoodSearchOptionLabels(choices),
      cursor: 0,
      loading: false,
      requestId: 0,
    };
  } catch (error) {
    closeFoodSearch(state);
    pushMessage(state, error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(timer);
    state.loadingItemKeys.delete(item.key);
    clearInteractiveScreen();
  }
}

async function logMealItems(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  items: MealPlanItemRef[],
  options: {
    replacement?: string;
    interactive: boolean;
  }
): Promise<void> {
  const pending = items.filter(item => !state.completedItemKeys.has(item.key));
  if (pending.length === 0) {
    pushMessage(state, 'everything selected is already checked');
    return;
  }

  const resolved: Array<{ item: MealPlanItemRef; food: ResolvedTrackFood }> = [];
  for (const item of pending) {
    const trackItem = options.replacement
      ? buildReplacementTrackItem(item, options.replacement, state.multipliers.get(item.key) ?? 1)
      : buildMealPlanTrackItem(item, state.multipliers.get(item.key) ?? 1);
    const result = await resolveTrackFood(
      session,
      cache,
      trackItem,
      formatEraFitTime(new Date()),
      {
        useCache: true,
        writeCache: !state.dryRun,
        interactive: options.interactive,
        aliases: foodCacheAliases(item),
        log: message => pushMessage(state, message),
      }
    ).catch(error => {
      pushMessage(state, error instanceof Error ? error.message : String(error));
      return null;
    });
    if (!result) {
      continue;
    }
    if (result.status === 'needs-selection') {
      if (!options.interactive) {
        state.pendingSearchItems.push(item);
      }
      break;
    }
    if (result.status === 'cancel') {
      if (options.interactive) {
        state.mode = 'meals';
      }
      pushMessage(state, options.interactive ? 'returned to meals' : `needs selection for ${formatItemDisplayName(item.item)}`);
      break;
    }
    if (result.status === 'skip') {
      pushMessage(state, `skipped ${formatItemDisplayName(item.item)}`);
      continue;
    }
    resolved.push({ item, food: result.food });
  }

  if (resolved.length === 0) {
    return;
  }

  await saveResolvedMealItems(session, dateId, state, resolved);
}

async function saveResolvedMealItems(
  session: EraFitSession,
  dateId: string,
  state: InteractiveState,
  resolved: Array<{ item: MealPlanItemRef; food: ResolvedTrackFood }>
): Promise<void> {
  const trackedEntries = state.dryRun
    ? resolved.map(entry => buildDryRunTrackedEntry(dateId, entry.item.trackingMeal, entry.food))
    : (await saveTrackedFoods(session, {
      dateId,
      meal: resolved[0].item.trackingMeal,
      foods: resolved.map(entry => entry.food),
    })).map(saved => trackedEntryFromSavedFood(resolved[0].item.trackingMeal, saved));

  for (const [index, entry] of resolved.entries()) {
    state.completedItemKeys.add(entry.item.key);
    state.existingItemKeys.delete(entry.item.key);
    const trackedEntry = trackedEntries[index];
    if (trackedEntry) {
      state.trackedItemByKey.set(entry.item.key, trackedEntry);
      state.trackedEntries.push(trackedEntry);
    }
  }
  invalidateRenderCache(state);
  const label = resolved.length === 1
    ? formatSavedMealItemLabel(resolved[0].item, trackedEntries[0])
    : `${resolved.length} items`;
  pushMessage(state, `${state.dryRun ? 'would log' : 'logged'} ${label}`);
}

function formatSavedMealItemLabel(item: MealPlanItemRef, tracked: TrackedFoodEntry | undefined): string {
  return tracked ? formatTrackedPlanItemLabel(tracked.record) : formatItemDisplayName(item.item);
}

function trackedEntryFromSavedFood(meal: EraFitMealKey, saved: SavedTrackFood): TrackedFoodEntry {
  return {
    meal,
    id: saved.id,
    record: saved.record,
  };
}

function buildDryRunTrackedEntry(dateId: string, meal: EraFitMealKey, food: ResolvedTrackFood): TrackedFoodEntry {
  const id = `dry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    meal,
    id,
    record: {
      ...food.record,
      id,
      meal_tracking_food_log: `${dateId}_${meal}_${id}`,
    },
  };
}

async function logSelectedFoodSearchChoice(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  index: number
): Promise<void> {
  const search = state.foodSearch;
  const choice = search?.choices[index];
  if (!search || !choice) {
    closeFoodSearch(state);
    return;
  }
  const result = await resolveTrackFoodFromSearchChoice(
    session,
    cache,
    search.trackItem,
    formatEraFitTime(new Date()),
    choice,
    {
      useCache: false,
      writeCache: !state.dryRun,
      interactive: true,
      forceServingPrompt: true,
      aliases: foodCacheAliases(search.item),
      log: message => pushMessage(state, message),
    }
  ).catch(error => {
    pushMessage(state, error instanceof Error ? error.message : String(error));
    return null;
  });
  if (!result) {
    closeFoodSearch(state);
    return;
  }
  if (result.status === 'needs-selection') {
    pushMessage(state, `serving selection needed for ${formatItemDisplayName(search.item.item)}`);
    closeFoodSearch(state);
    return;
  }
  if (result.status === 'cancel') {
    closeFoodSearch(state);
    return;
  }
  if (result.status === 'skip') {
    pushMessage(state, `skipped ${formatItemDisplayName(search.item.item)}`);
    closeFoodSearch(state);
    return;
  }
  await saveResolvedMealItems(session, dateId, state, [{ item: search.item, food: result.food }]);
  closeFoodSearch(state);
}

async function logSelectedAddFoodChoice(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  index: number
): Promise<void> {
  const add = state.addFood;
  const choice = add?.choices[index];
  const meal = add ? state.meals[add.mealIndex] : null;
  if (!add || !choice || !meal) {
    return;
  }

  const trackItem = buildAddTrackItem(choice, add.query);
  const result = await resolveTrackFoodFromSearchChoice(
    session,
    cache,
    trackItem,
    formatEraFitTime(new Date()),
    choice,
    {
      useCache: false,
      writeCache: !state.dryRun,
      interactive: true,
      log: message => pushMessage(state, message),
    }
  ).catch(error => {
    pushMessage(state, error instanceof Error ? error.message : String(error));
    return null;
  });

  if (!result) {
    return;
  }
  if (result.status === 'needs-selection') {
    pushMessage(state, `serving selection needed for ${trackItem.query}`);
    return;
  }
  if (result.status === 'cancel') {
    pushMessage(state, 'add cancelled');
    return;
  }
  if (result.status === 'skip') {
    pushMessage(state, `skipped ${trackItem.query}`);
    return;
  }

  await saveAddedFoodToMeal(session, cache, dateId, state, add.mealIndex, result.food);
}

async function editTrackedRowServing(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  row: MealPlanRowRef
): Promise<void> {
  const tracked = trackedEntryForRow(state, row);
  if (!tracked) {
    pushMessage(state, 'nothing tracked to edit');
    return;
  }
  const past = pastFoodSearchItemFromTrackedEntry(tracked);
  if (!past) {
    pushMessage(state, 'cannot edit this tracked food');
    return;
  }
  const trackItem = buildPastTrackItem(past);
  const result = await resolveTrackFoodFromSearchChoice(
    session,
    cache,
    trackItem,
    formatEraFitTime(new Date()),
    { type: 'past', past },
    {
      useCache: false,
      writeCache: false,
      interactive: true,
      log: message => pushMessage(state, message),
    }
  ).catch(error => {
    pushMessage(state, error instanceof Error ? error.message : String(error));
    return null;
  });

  if (!result) {
    return;
  }
  if (result.status === 'needs-selection') {
    pushMessage(state, `serving selection needed for ${past.name}`);
    return;
  }
  if (result.status === 'cancel') {
    pushMessage(state, 'edit cancelled');
    return;
  }
  if (result.status === 'skip') {
    pushMessage(state, `skipped ${past.name}`);
    return;
  }

  const updated = state.dryRun
    ? editedTrackedEntry(tracked, result.food)
    : trackedEntryFromSavedFood(tracked.meal, await updateTrackedFood(session, {
      dateId,
      meal: tracked.meal,
      existing: tracked,
      food: result.food,
    }));
  replaceTrackedRow(state, row, tracked, updated);
  pushMessage(state, `${state.dryRun ? 'would edit' : 'edited'} ${formatTrackedFoodDisplayName(updated.record)}`);
}

function buildAddTrackItem(choice: FoodSearchChoice, query: string): ParsedTrackItem {
  if (choice.type === 'saved') {
    return parseTrackItem(`1 ${choice.saved.name}`);
  }
  if (choice.type === 'past') {
    return buildPastTrackItem(choice.past);
  }
  const label = query.trim() || choice.food.food_name;
  return parseTrackItem(`1 ${label}|${choice.food.food_id}`);
}

function buildPastTrackItem(past: PastFoodSearchItem): ParsedTrackItem {
  const amount = past.servingQuantity > 0 ? past.servingQuantity : 1;
  const unit = formatPastTrackUnit(past.servingUnit);
  return parseTrackItem(`${formatNumber(amount)}${unit} ${past.name}`);
}

function formatPastTrackUnit(unit: string): string {
  const normalized = unit.trim().replace(/\s+/g, '_');
  return normalized && normalized !== 'fatsecret' && /^[A-Za-z_][A-Za-z_.%/-]*$/.test(normalized)
    ? normalized
    : '';
}

function editedTrackedEntry(existing: TrackedFoodEntry, food: ResolvedTrackFood): TrackedFoodEntry {
  return {
    meal: existing.meal,
    id: existing.id,
    record: {
      ...food.record,
      id: existing.id,
      meal_tracking_food_log: existing.record.meal_tracking_food_log,
    },
  };
}

function replaceTrackedRow(
  state: InteractiveState,
  row: MealPlanRowRef,
  previous: TrackedFoodEntry,
  updated: TrackedFoodEntry
): void {
  const previousKey = trackedEntryKey(previous);
  state.trackedEntries = state.trackedEntries.map(entry => trackedEntryKey(entry) === previousKey ? updated : entry);
  if (!state.trackedEntries.some(entry => trackedEntryKey(entry) === trackedEntryKey(updated))) {
    state.trackedEntries.push(updated);
  }
  if (row.type === 'plan') {
    state.trackedItemByKey.set(row.item.key, updated);
    state.completedItemKeys.add(row.item.key);
  } else {
    row.item.entry = updated;
  }
  invalidateRenderCache(state);
}

function trackedEntryForRow(state: InteractiveState, row: MealPlanRowRef): TrackedFoodEntry | null {
  return row.type === 'plan'
    ? state.trackedItemByKey.get(row.item.key) ?? null
    : row.item.entry;
}

function rowCanEditServing(state: InteractiveState, row: MealPlanRowRef | null): boolean {
  if (!row) {
    return false;
  }
  return trackedEntryForRow(state, row) != null;
}

async function saveAddedFoodToMeal(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  mealIndex: number,
  food: ResolvedTrackFood
): Promise<void> {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return;
  }
  let entry: TrackedFoodEntry;
  if (state.dryRun) {
    entry = buildDryRunTrackedEntry(dateId, meal.trackingMeal, food);
  } else {
    const [saved] = await saveTrackedFoods(session, {
      dateId,
      meal: meal.trackingMeal,
      foods: [food],
    });
    if (!saved) {
      return;
    }
    entry = trackedEntryFromSavedFood(meal.trackingMeal, saved);
  }
  state.trackedEntries.push(entry);
  refreshExistingTrackedMatches(cache, state);
  invalidateRenderCache(state);
  state.addFood = null;
  state.mode = 'items';
  state.mealCursor = mealIndex;
  state.itemCursor = trackedEntryRowIndex(state, mealIndex, entry);
  pushMessage(state, `${state.dryRun ? 'would add' : 'added'} ${formatTrackedFoodDisplayName(entry.record)} to ${meal.meal.meal}`);
}

async function uncheckMealItems(
  session: EraFitSession,
  dateId: string,
  state: InteractiveState,
  items: MealPlanItemRef[]
): Promise<void> {
  const checked = items.filter(item => state.completedItemKeys.has(item.key));
  if (checked.length === 0) {
    return;
  }
  const tracked = checked
    .map(item => state.trackedItemByKey.get(item.key))
    .filter((entry): entry is TrackedFoodEntry => entry != null);

  if (!state.dryRun && tracked.length > 0) {
    await deleteTrackedFoods(session, {
      dateId,
      foods: tracked,
    });
  }

  for (const item of checked) {
    state.completedItemKeys.delete(item.key);
    state.existingItemKeys.delete(item.key);
    state.trackedItemByKey.delete(item.key);
  }
  if (!state.dryRun && tracked.length > 0) {
    const removed = new Set(tracked.map(trackedEntryKey));
    state.trackedEntries = state.trackedEntries.filter(entry => !removed.has(trackedEntryKey(entry)));
  }
  invalidateRenderCache(state);
  const label = checked.length === 1
    ? formatItemDisplayName(checked[0].item)
    : `${checked.length} items`;
  pushMessage(state, `${state.dryRun ? 'would uncheck' : 'unchecked'} ${label}`);
}

function foodCacheAliases(item: MealPlanItemRef): string[] {
  return uniqueStrings([
    item.item.name,
    formatItemDisplayName(item.item),
  ]).filter(alias => alias.trim().length > 0);
}

function closeFoodSearch(state: InteractiveState): void {
  state.foodSearch = null;
  state.mode = 'items';
}

const ADD_FOOD_TABS = ['search', 'past', 'faves', 'meals', 'food'] as const satisfies readonly AddFoodTab[];

function openAddMode(state: InteractiveState, mealIndex: number): void {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return;
  }
  state.mode = 'add';
  state.mealCursor = mealIndex;
  state.addFood = {
    mealIndex,
    tab: 'search',
    query: '',
    choices: [],
    cursor: 0,
    loading: false,
    requestId: 0,
    pastFoods: null,
    savedFoods: null,
  };
}

function closeAddMode(state: InteractiveState): void {
  state.addFood = null;
  state.mode = 'meals';
}

async function loadAddFoodChoices(session: EraFitSession, add: AddFoodState): Promise<FoodSearchChoice[]> {
  const query = add.query.trim();
  if (add.tab === 'search') {
    if (!query) {
      return [];
    }
    return (await searchEraFitFatSecretFoods(session, query))
      .slice(0, 10)
      .map(food => ({ type: 'fatsecret' as const, food }));
  }

  if (add.tab === 'past') {
    if (!add.pastFoods) {
      add.pastFoods = await listPastTrackedFoods(session);
    }
    return searchPastTrackedFoods(add.pastFoods, query)
      .map(past => ({ type: 'past' as const, past }));
  }

  if (!add.savedFoods) {
    add.savedFoods = await listSavedFoods(session);
  }
  return selectSavedAddFoods(add.savedFoods, add.tab, query)
    .map(saved => ({ type: 'saved' as const, saved }));
}

function selectSavedAddFoods(foods: SavedFoodSearchItem[], tab: AddFoodTab, query: string): SavedFoodSearchItem[] {
  const source = savedSourceForAddTab(tab);
  if (!source) {
    return [];
  }
  const normalizedQuery = normalizeFoodCacheKey(query);
  return foods
    .filter(food => food.source === source)
    .map(food => ({ food, score: scoreAddFoodMatch(food, normalizedQuery) }))
    .filter(entry => !normalizedQuery || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.food.timestamp - a.food.timestamp || a.food.name.localeCompare(b.food.name))
    .map(entry => entry.food)
    .slice(0, 10);
}

function savedSourceForAddTab(tab: AddFoodTab): SavedFoodSource | null {
  if (tab === 'faves') return 'favorite';
  if (tab === 'meals') return 'my_meal';
  if (tab === 'food') return 'custom_food';
  return null;
}

function scoreAddFoodMatch(food: SavedFoodSearchItem, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 1;
  }
  const searchable = normalizeFoodCacheKey([food.name, food.brandName].filter(Boolean).join(' '));
  if (searchable === normalizedQuery) {
    return 100;
  }
  if (searchable.includes(normalizedQuery)) {
    return 80;
  }
  const tokens = normalizedQuery.split(' ').filter(token => token.length > 2);
  if (tokens.length === 0) {
    return 0;
  }
  const overlap = tokens.filter(token => searchable.includes(token)).length;
  return overlap === 0 ? 0 : (overlap / tokens.length) * 60;
}

function getMealRows(state: InteractiveState, mealIndex: number): MealPlanRowRef[] {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return [];
  }
  return [
    ...meal.items.map(item => ({ type: 'plan' as const, item })),
    ...meal.outsideItems.map(item => ({ type: 'outside' as const, item })),
  ];
}

function getMealRow(state: InteractiveState, mealIndex: number, rowIndex: number): MealPlanRowRef | null {
  return getMealRows(state, mealIndex)[rowIndex] ?? null;
}

function firstUncheckedRowIndex(state: InteractiveState, mealIndex: number): number {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return 0;
  }
  const uncheckedIndex = meal.items.findIndex(item => !state.completedItemKeys.has(item.key));
  return uncheckedIndex === -1 ? 0 : uncheckedIndex;
}

function getAssignablePlanItems(state: InteractiveState): MealPlanItemRef[] {
  return state.meals.flatMap(meal =>
    meal.items.filter(item => !state.completedItemKeys.has(item.key) && !state.loadingItemKeys.has(item.key))
  );
}

function itemRowIndex(state: InteractiveState, item: MealPlanItemRef): number {
  return Math.max(0, state.meals[item.mealIndex]?.items.findIndex(candidate => candidate.key === item.key) ?? 0);
}

function outsideItemRowIndex(state: InteractiveState, item: OutsidePlanItemRef): number {
  const meal = state.meals[item.mealIndex];
  if (!meal) {
    return 0;
  }
  const outsideIndex = meal.outsideItems.findIndex(candidate => candidate.key === item.key);
  return meal.items.length + Math.max(0, outsideIndex);
}

function trackedEntryRowIndex(state: InteractiveState, mealIndex: number, entry: TrackedFoodEntry): number {
  const key = trackedEntryKey(entry);
  const index = getMealRows(state, mealIndex).findIndex(row => {
    const rowEntry = trackedEntryForRow(state, row);
    return rowEntry ? trackedEntryKey(rowEntry) === key : false;
  });
  return Math.max(0, index);
}

function startAssignMode(state: InteractiveState, source: OutsidePlanItemRef): void {
  const targets = getAssignablePlanItems(state);
  if (targets.length === 0) {
    pushMessage(state, 'no unchecked mealplan items to assign');
    return;
  }
  const target = targets.find(item => item.mealIndex === source.mealIndex) ?? targets[0];
  state.assignSource = source;
  state.mode = 'assign';
  state.mealCursor = target.mealIndex;
  state.itemCursor = itemRowIndex(state, target);
  pushMessage(state, `assign ${formatTrackedFoodDisplayName(source.entry.record)} to a mealplan item`);
}

function assignOutsideTrackedFood(
  cache: EraFitCache,
  state: InteractiveState,
  source: OutsidePlanItemRef,
  target: MealPlanItemRef
): void {
  if (state.completedItemKeys.has(target.key)) {
    pushMessage(state, 'choose an unchecked mealplan item');
    return;
  }
  const selection = cachedSelectionFromTrackedEntry(source.entry);
  if (!selection) {
    pushMessage(state, `cannot cache ${formatTrackedFoodDisplayName(source.entry.record)}`);
    return;
  }
  const assignedSelection = {
    ...selection,
    servingMultiplier: inferAssignedServingMultiplier(source.entry.record, target.item),
  };
  const aliases = foodCacheAliases(target);
  if (!state.dryRun) {
    for (const alias of aliases) {
      rememberFoodSelection(cache, alias, assignedSelection);
    }
  } else {
    rememberFoodSelectionInMemory(cache, aliases, assignedSelection);
  }
  refreshExistingTrackedMatches(cache, state);
  invalidateRenderCache(state);
  state.assignSource = null;
  state.mode = 'items';
  state.mealCursor = target.mealIndex;
  state.itemCursor = itemRowIndex(state, target);
  pushMessage(state, `${state.dryRun ? 'would assign' : 'assigned'} ${formatTrackedFoodDisplayName(source.entry.record)} to ${formatItemDisplayName(target.item)}`);
}

function rememberFoodSelectionInMemory(
  cache: EraFitCache,
  aliases: string[],
  selection: Omit<CachedFoodSelection, 'updatedAt'>
): void {
  for (const alias of aliases) {
    const key = normalizeFoodCacheKey(alias);
    if (!key) {
      continue;
    }
    cache.foods[key] = {
      ...selection,
      updatedAt: new Date().toISOString(),
    };
  }
}

function inferAssignedServingMultiplier(record: TrackedFoodRecord, target: EraFitMealPlanFoodItem): number | undefined {
  const sourceQuantity = parseNumberLike(record.serving_qtd);
  const targetQuantity = target.amount != null && target.amount > 0 ? target.amount : 1;
  if (sourceQuantity == null || sourceQuantity <= 0 || targetQuantity <= 0) {
    return undefined;
  }
  return roundNumber(sourceQuantity / targetQuantity);
}

function refreshExistingTrackedMatches(cache: EraFitCache, state: InteractiveState): void {
  const sessionCompleted = new Set(
    Array.from(state.completedItemKeys).filter(key => !state.existingItemKeys.has(key))
  );
  const sessionTracked = Array.from(state.trackedItemByKey.entries())
    .filter(([key]) => sessionCompleted.has(key));
  const matched = matchExistingTrackedItems(cache, state.meals, state.trackedEntries);
  state.completedItemKeys = new Set([...sessionCompleted, ...matched.completed]);
  state.existingItemKeys = new Set(matched.completed);
  state.trackedItemByKey = new Map([...sessionTracked, ...matched.trackedByItemKey]);
  for (const [mealIndex, meal] of state.meals.entries()) {
    meal.outsideItems = matched.outsideByMeal.get(meal.trackingMeal)?.map((entry, outsideIndex) => ({
      key: `${meal.trackingMeal}:outside:${entry.id}:${outsideIndex}`,
      mealIndex,
      trackingMeal: meal.trackingMeal,
      entry,
    })) ?? [];
  }
  invalidateRenderCache(state);
}

function cachedSelectionFromTrackedEntry(entry: TrackedFoodEntry): Omit<CachedFoodSelection, 'updatedAt'> | null {
  const record = entry.record as TrackedFoodRecord & {
    type_item?: string;
    food_customized_id?: string;
    title?: string;
  };
  const foodId = nonEmptyString(record.food_id);
  const customFoodId = nonEmptyString(record.food_customized_id);
  const foodName = nonEmptyString(record.food_name) ?? nonEmptyString(record.title);
  if (!foodName) {
    return null;
  }

  const servingQuantity = parseNumberLike(record.serving_qtd) ?? undefined;
  const base = {
    foodId: foodId ?? customFoodId ?? nonEmptyString(record.id) ?? '',
    foodName,
    brandName: nonEmptyString(record.brand_name) ?? undefined,
    servingDescription: nonEmptyString(record.serving_description) ?? formatTrackedServing(record),
    servingUnit: nonEmptyString(record.serving_unit) ?? undefined,
    servingQuantity,
  };

  if (record.type_item === 'my_meals' || record.food_type === 'my_meals') {
    const savedId = foodId ?? nonEmptyString(record.id);
    if (!savedId) {
      return null;
    }
    return {
      ...base,
      foodId: savedId,
      servingType: 'saved',
      savedSource: 'my_meal',
      savedId,
    };
  }

  if (record.type_item === 'food_customized' || customFoodId) {
    if (!customFoodId) {
      return null;
    }
    return {
      ...base,
      foodId: customFoodId,
      servingType: 'saved',
      savedSource: 'custom_food',
      savedId: customFoodId,
      customFoodId,
    };
  }

  if (!foodId) {
    return null;
  }

  const standardUnit = parseCacheStandardUnit(record.serving_unit);
  if (standardUnit) {
    return {
      ...base,
      servingType: 'standard',
      servingUnit: standardUnit,
    };
  }

  if (record.serving_id) {
    return {
      ...base,
      servingType: 'fatsecret',
      servingId: record.serving_id,
    };
  }

  return null;
}

function buildMealPlanTrackItem(item: MealPlanItemRef, multiplier: number): ParsedTrackItem {
  return parseTrackItem(buildMealPlanTrackInput(item.item, item.item.name, multiplier));
}

function buildReplacementTrackItem(item: MealPlanItemRef, replacement: string, multiplier: number): ParsedTrackItem {
  const direct = tryParseTrackItem(replacement);
  if (direct) {
    return direct;
  }
  const normalized = replacement.trim();
  const query = /^\d+$/.test(normalized) && normalized.length < 6
    ? `${normalized}|${normalized}`
    : normalized;
  return parseTrackItem(buildMealPlanTrackInput(item.item, query, multiplier));
}

function buildMealPlanTrackInput(item: EraFitMealPlanFoodItem, query: string, multiplier: number): string {
  const amount = item.amount != null && item.amount > 0 ? item.amount * multiplier : 1 * multiplier;
  const unit = item.amount != null && item.unit ? item.unit : '';
  return `${formatNumber(roundNumber(amount))}${unit} ${query}`;
}

function matchExistingTrackedItems(
  cache: EraFitCache,
  meals: InteractiveState['meals'],
  tracked: TrackedFoodEntry[]
): {
  completed: Set<string>;
  trackedByItemKey: Map<string, TrackedFoodEntry>;
  outsideByMeal: Map<EraFitMealKey, TrackedFoodEntry[]>;
} {
  const completed = new Set<string>();
  const trackedByItemKey = new Map<string, TrackedFoodEntry>();
  const used = new Set<string>();
  for (const meal of meals) {
    const candidates = tracked.filter(entry => entry.meal === meal.trackingMeal);
    for (const item of meal.items) {
      const best = findBestCachedTrackedMatch(cache, item, candidates, used);
      if (!best) {
        continue;
      }
      completed.add(item.key);
      trackedByItemKey.set(item.key, best);
      used.add(trackedEntryKey(best));
    }

    for (const item of meal.items) {
      if (completed.has(item.key)) {
        continue;
      }
      const best = findBestTextTrackedMatch(item.item, candidates, used);
      if (!best) {
        continue;
      }
      completed.add(item.key);
      trackedByItemKey.set(item.key, best);
      used.add(trackedEntryKey(best));
    }

    for (const item of meal.items) {
      if (completed.has(item.key)) {
        continue;
      }
      const best = findBestMacroProximityMatch(item.item, candidates, used);
      if (!best) {
        continue;
      }
      completed.add(item.key);
      trackedByItemKey.set(item.key, best);
      used.add(trackedEntryKey(best));
    }
  }
  const outsideByMeal = new Map<EraFitMealKey, TrackedFoodEntry[]>();
  for (const entry of tracked) {
    if (used.has(trackedEntryKey(entry))) {
      continue;
    }
    const entries = outsideByMeal.get(entry.meal) ?? [];
    entries.push(entry);
    outsideByMeal.set(entry.meal, entries);
  }
  return { completed, trackedByItemKey, outsideByMeal };
}

function findBestCachedTrackedMatch(
  cache: EraFitCache,
  item: MealPlanItemRef,
  candidates: TrackedFoodEntry[],
  used: Set<string>
): TrackedFoodEntry | null {
  const aliases = foodCacheAliases(item)
    .map(alias => cache.foods[normalizeFoodCacheKey(alias)])
    .filter((cached): cached is CachedFoodSelection => cached != null);
  if (aliases.length === 0) {
    return null;
  }
  return candidates.find(entry =>
    !used.has(trackedEntryKey(entry)) &&
    aliases.some(cached =>
      trackedRecordMatchesCachedSelection(entry.record, cached) &&
      trackedRecordCoversCachedServing(entry.record, cached, item.item)
    )
  ) ?? null;
}

function trackedRecordCoversCachedServing(
  record: TrackedFoodRecord,
  cached: CachedFoodSelection,
  item: EraFitMealPlanFoodItem
): boolean {
  if (!cached.servingMultiplier) {
    return true;
  }
  const expected = (item.amount != null && item.amount > 0 ? item.amount : 1) * cached.servingMultiplier;
  const actual = parseNumberLike(record.serving_qtd);
  if (actual == null) {
    return false;
  }
  return Math.abs(actual - expected) <= Math.max(0.01, expected * 0.02);
}

function trackedRecordMatchesCachedSelection(record: TrackedFoodRecord, cached: CachedFoodSelection): boolean {
  const raw = record as TrackedFoodRecord & {
    type_item?: string;
    food_customized_id?: string;
    title?: string;
  };
  if (cached.servingType === 'saved') {
    if (cached.savedSource === 'custom_food') {
      return Boolean(cached.customFoodId && raw.food_customized_id === cached.customFoodId) ||
        Boolean(cached.savedId && (raw.food_customized_id === cached.savedId || record.food_id === cached.savedId));
    }
    if (cached.savedSource === 'my_meal') {
      return raw.type_item === 'my_meals' &&
        (record.food_id === cached.savedId || record.food_id === cached.foodId || raw.title === cached.foodName);
    }
    return record.food_id === cached.foodId || normalizeMatchText(record.food_name ?? '') === normalizeMatchText(cached.foodName);
  }
  if (record.food_id !== cached.foodId) {
    return false;
  }
  if (cached.servingType === 'standard' && cached.servingUnit) {
    return normalizeServingText(record.serving_unit) === normalizeServingText(cached.servingUnit);
  }
  return !cached.servingId || record.serving_id === cached.servingId;
}

function findBestTextTrackedMatch(
  item: EraFitMealPlanFoodItem,
  candidates: TrackedFoodEntry[],
  used: Set<string>
): TrackedFoodEntry | null {
  const best = candidates
    .filter(entry => !used.has(trackedEntryKey(entry)))
    .map(entry => ({
      entry,
      score: scoreTrackedTextMatch(item, entry.record),
    }))
    .filter(match => match.score >= 4)
    .sort((a, b) => b.score - a.score)[0];
  return best?.entry ?? null;
}

function findBestMacroProximityMatch(
  item: EraFitMealPlanFoodItem,
  candidates: TrackedFoodEntry[],
  used: Set<string>
): TrackedFoodEntry | null {
  const best = candidates
    .filter(entry => !used.has(trackedEntryKey(entry)))
    .filter(entry => macrosAreWithinFivePercent(item, entry.record))
    .map(entry => ({
      entry,
      distance: macroProximityDistance(item, entry.record),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
  return best?.entry ?? null;
}

function trackedEntryKey(entry: TrackedFoodEntry): string {
  return `${entry.meal}:${entry.id}`;
}

function scoreTrackedTextMatch(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): number {
  const itemTokens = tokenize(`${item.name} ${item.description ?? ''}`);
  const recordTokens = tokenize(record.food_name ?? '');
  const overlap = itemTokens.filter(token => recordTokens.includes(token)).length;
  if (overlap === 0) {
    return 0;
  }
  const tokenRatio = overlap / Math.max(1, Math.min(itemTokens.length, recordTokens.length));
  let score = tokenRatio * 4;
  const itemName = normalizeMatchText(item.name);
  const recordName = normalizeMatchText(record.food_name ?? '');
  if (itemName.includes(recordName) || recordName.includes(itemName)) {
    score += 2;
  }

  const itemGrams = item.unit === 'g' ? item.amount : null;
  const recordGrams = trackedRecordGrams(record);
  if (itemGrams != null && recordGrams != null) {
    const difference = Math.abs(itemGrams - recordGrams);
    if (difference <= Math.max(8, itemGrams * 0.08)) score += 3;
    else if (difference <= Math.max(25, itemGrams * 0.18)) score += 1;
  }
  return score;
}

function macrosAreWithinFivePercent(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): boolean {
  const pairs = macroPairs(item, record);
  return pairs != null && pairs.every(([planned, tracked]) => isWithinFivePercent(planned, tracked));
}

function macroProximityDistance(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): number {
  return macroPairs(item, record)?.reduce((sum, [planned, tracked]) => {
    if (planned === 0) {
      return sum + Math.abs(tracked);
    }
    return sum + Math.abs(planned - tracked) / Math.abs(planned);
  }, 0) ?? Number.POSITIVE_INFINITY;
}

function macroPairs(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): Array<[number, number]> | null {
  const pairs = [
    [item.calories, record.calories],
    [item.protein, record.protein],
    [item.net_carbs, record.carbohydrate],
    [item.fat, record.fat],
  ];
  if (pairs.some(([planned, tracked]) => planned == null || !Number.isFinite(tracked))) {
    return null;
  }
  return pairs as Array<[number, number]>;
}

function isWithinFivePercent(planned: number, tracked: number): boolean {
  if (planned === 0) {
    return Math.abs(tracked) <= 0.1;
  }
  return Math.abs(planned - tracked) <= Math.abs(planned) * 0.05;
}

function trackedRecordGrams(record: TrackedFoodRecord): number | null {
  if (record.serving_unit === 'g') {
    return parseNumberLike(record.serving_qtd);
  }
  const servingQuantity = parseNumberLike(record.serving_qtd) ?? 1;
  const metricAmount = parseNumberLike(record.metric_serving_amount);
  if (metricAmount == null) {
    return null;
  }
  if (record.metric_serving_unit === 'g') {
    return metricAmount * servingQuantity;
  }
  if (record.metric_serving_unit === 'oz') {
    return metricAmount * 28.3495 * servingQuantity;
  }
  return null;
}

function tokenize(value: string): string[] {
  return normalizeMatchText(value)
    .split(' ')
    .filter(token => token.length > 2 && !['and', 'with', 'the', 'raw'].includes(token));
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\b(?:large|medium|small|sliced|diced|grilled|scrambled|cooked|raw|steamed|roasted|sauteed)\b/g, ' ')
    .replace(/\b(?:oatmeal|oats)\b/g, ' oat ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeServingText(value: string | null | undefined): string {
  return value?.toLowerCase().replaceAll(/[_\s]+/g, ' ').replace(/s$/, '') ?? '';
}

function parseCacheStandardUnit(value: string | null | undefined): 'g' | 'oz' | 'ml' | 'fl_oz' | null {
  const normalized = normalizeServingText(value).replaceAll(' ', '_');
  if (['g', 'gram'].includes(normalized)) return 'g';
  if (['oz', 'ounce'].includes(normalized)) return 'oz';
  if (['ml', 'milliliter'].includes(normalized)) return 'ml';
  if (['fl_oz', 'floz', 'fluid_ounce'].includes(normalized)) return 'fl_oz';
  return null;
}

function formatTrackedServing(record: TrackedFoodRecord): string {
  const quantity = parseNumberLike(record.serving_qtd);
  const unit = nonEmptyString(record.serving_unit);
  return [quantity == null ? null : formatNumber(quantity), unit].filter(Boolean).join(' ') || 'serving';
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

class MealPlanChecklistPrompt {
  private readonly input = process.stdin;
  private readonly output = process.stdout;
  private repaintTimer: ReturnType<typeof setInterval> | null = null;
  private foodSearchDebounce: ReturnType<typeof setTimeout> | null = null;
  private addFoodDebounce: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private hadAnimatedState = false;
  private resolvePrompt: ((action: MealPlanPromptAction | undefined) => void) | null = null;
  private readonly keypressHandler = (key: string | undefined, info: Key) => this.handleKeypress(key, info);

  constructor(
    private readonly session: EraFitSession,
    private readonly cache: EraFitCache,
    private readonly view: InteractiveState
  ) {}

  async prompt(): Promise<MealPlanPromptAction | undefined> {
    return await new Promise(resolve => {
      this.resolvePrompt = resolve;
      this.disposed = false;
      this.output.write('\x1b[?25l');
      ensureKeypressEvents(this.input);
      this.input.resume();
      if (this.input.isTTY) {
        this.input.setRawMode(true);
      }
      this.input.on('keypress', this.keypressHandler);
      this.repaintTimer = setInterval(() => this.tick(), 120);
      this.repaint();
    });
  }

  private tick(): void {
    const pendingSearch = this.view.pendingSearchItems.shift();
    if (pendingSearch) {
      this.view.mode = 'items';
      this.view.mealCursor = pendingSearch.mealIndex;
      this.view.itemCursor = pendingSearch.itemIndex;
      this.submitAction({
        type: 'open-food-search',
        mealIndex: pendingSearch.mealIndex,
        rowIndex: pendingSearch.itemIndex,
      });
      return;
    }

    const hasAnimatedState = this.view.loadingItemKeys.size > 0 || this.view.foodSearch?.loading === true;
    const hasAddAnimatedState = this.view.addFood?.loading === true;
    if (hasAnimatedState || hasAddAnimatedState || this.hadAnimatedState) {
      this.hadAnimatedState = hasAnimatedState || hasAddAnimatedState;
      this.repaint();
    }
  }

  private repaint(): void {
    if (this.disposed) {
      return;
    }
    clearInteractiveScreen(this.output);
    this.output.write(renderMealPlanFrame(this.view));
  }

  private cleanupTimers(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.repaintTimer) {
      clearInterval(this.repaintTimer);
      this.repaintTimer = null;
    }
    if (this.foodSearchDebounce) {
      clearTimeout(this.foodSearchDebounce);
      this.foodSearchDebounce = null;
    }
    if (this.addFoodDebounce) {
      clearTimeout(this.addFoodDebounce);
      this.addFoodDebounce = null;
    }
    this.input.off('keypress', this.keypressHandler);
    if (this.input.isTTY) {
      this.input.setRawMode(false);
    }
    this.output.write('\x1b[?25h');
  }

  private handleKeypress(key: string | undefined, info: Key): void {
    if (this.view.mode === 'food-search') {
      this.clearExpandedItem();
      this.handleFoodSearchKey(key, info);
      return;
    }
    if (this.view.mode === 'add') {
      this.clearExpandedItem();
      this.handleAddFoodKey(key, info);
      return;
    }
    const command = key?.toLowerCase();
    if (command === 'e' && this.view.mode === 'items') {
      if (this.submitCurrentEditServing() || this.toggleCurrentExpansion()) {
        return;
      }
    }
    if (command === 'o' && this.view.mode === 'meals' && this.toggleCurrentOriginalSection()) {
      return;
    }
    if (info.ctrl && info.name === 'c') {
      this.clearExpandedItem();
      this.submitAction({ type: 'done' });
      return;
    }
    if (info.name === 'up' || info.name === 'down') {
      this.clearExpandedItem();
      this.moveCursor(info.name === 'up' ? -1 : 1);
      this.repaint();
      return;
    }
    if (info.name === 'right' && this.view.mode === 'meals') {
      this.clearExpandedItem();
      this.view.mode = 'items';
      this.view.itemCursor = firstUncheckedRowIndex(this.view, this.view.mealCursor);
      this.repaint();
      return;
    }
    if (info.name === 'left' && this.view.mode === 'items') {
      this.clearExpandedItem();
      this.view.mode = 'meals';
      this.repaint();
      return;
    }
    if (info.name === 'left' && this.view.mode === 'assign') {
      this.clearExpandedItem();
      this.cancelAssignMode();
      return;
    }
    if (info.name === 'escape') {
      this.clearExpandedItem();
      this.goBack();
      return;
    }
    if (info.name === 'space' || key === ' ') {
      this.clearExpandedItem();
      if (this.view.mode === 'assign') {
        this.assignCurrentOutside();
      } else {
        this.submitCurrentToggle();
      }
      return;
    }

    if (command === 'q') {
      this.clearExpandedItem();
      this.submitAction({ type: 'done' });
    } else if (command === 'a' && this.view.mode === 'meals') {
      this.clearExpandedItem();
      this.openCurrentAddMode();
    } else if (command === 'a' && this.view.mode === 'items' && this.currentRow()?.type === 'outside') {
      this.clearExpandedItem();
      const row = this.currentRow();
      if (row?.type === 'outside') {
        startAssignMode(this.view, row.item);
        this.repaint();
      }
    } else if (command === 'a' && this.view.mode === 'assign') {
      this.clearExpandedItem();
      this.assignCurrentOutside();
    } else if (command === 's' && this.view.mode === 'items' && this.currentRow()?.type === 'plan') {
      this.clearExpandedItem();
      this.submitAction({
        type: 'open-food-search',
        mealIndex: this.view.mealCursor,
        rowIndex: this.view.itemCursor,
      });
    } else if (command === 'r' && this.view.mode === 'items' && this.currentRow()?.type === 'plan') {
      this.clearExpandedItem();
      this.submitAction({
        type: 'set-serving',
        mealIndex: this.view.mealCursor,
        rowIndex: this.view.itemCursor,
      });
    }
  }

  private handleAddFoodKey(
    key: string | undefined,
    info: { name?: string; ctrl?: boolean; meta?: boolean }
  ): void {
    if (info.ctrl && info.name === 'c') {
      this.submitAction({ type: 'done' });
      return;
    }
    if (info.name === 'escape') {
      this.goBack();
      return;
    }
    if (info.name === 'return') {
      this.submitCurrentAddFood();
      return;
    }
    if (info.name === 'left' || info.name === 'right') {
      this.switchAddFoodTab(info.name === 'left' ? -1 : 1);
      return;
    }
    if (info.name === 'up' || info.name === 'down') {
      this.moveAddFoodCursor(info.name === 'up' ? -1 : 1);
      this.repaint();
      return;
    }
    if (info.name === 'backspace' || info.name === 'delete') {
      const add = this.view.addFood;
      if (add?.query) {
        this.updateAddFoodQuery(add.query.slice(0, -1));
      }
      return;
    }
    if (key && key.length === 1 && !info.ctrl && !info.meta) {
      const add = this.view.addFood;
      if (add) {
        this.updateAddFoodQuery(`${add.query}${key}`);
      }
    }
  }

  private handleFoodSearchKey(
    key: string | undefined,
    info: { name?: string; ctrl?: boolean; meta?: boolean }
  ): void {
    if (info.ctrl && info.name === 'c') {
      this.submitAction({ type: 'done' });
      return;
    }
    if (info.name === 'escape') {
      this.goBack();
      return;
    }
    if (info.name === 'return') {
      this.submitCurrentFoodSearch();
      return;
    }
    if (info.name === 'up' || info.name === 'down') {
      this.moveFoodSearchCursor(info.name === 'up' ? -1 : 1);
      this.repaint();
      return;
    }
    if (info.name === 'backspace' || info.name === 'delete') {
      const search = this.view.foodSearch;
      if (search?.query) {
        this.updateFoodSearchQuery(search.query.slice(0, -1));
      }
      return;
    }
    if (key && key.length === 1 && !info.ctrl && !info.meta) {
      const search = this.view.foodSearch;
      if (search) {
        this.updateFoodSearchQuery(`${search.query}${key}`);
      }
    }
  }

  private updateFoodSearchQuery(query: string): void {
    if (this.disposed) {
      return;
    }
    const search = this.view.foodSearch;
    if (!search) {
      return;
    }
    search.query = query;
    search.choices = [];
    search.labels = [];
    search.cursor = 0;
    search.loading = true;
    search.requestId += 1;
    const requestId = search.requestId;
    if (query.trim()) {
      search.trackItem = buildReplacementTrackItem(search.item, query, this.view.multipliers.get(search.item.key) ?? 1);
    }
    if (this.foodSearchDebounce) {
      clearTimeout(this.foodSearchDebounce);
    }
    this.repaint();
    this.foodSearchDebounce = setTimeout(() => void this.refreshFoodSearch(requestId), 250);
  }

  private async refreshFoodSearch(requestId: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const search = this.view.foodSearch;
    if (!search || search.requestId !== requestId) {
      return;
    }
    if (!search.query.trim()) {
      search.loading = false;
      this.repaint();
      return;
    }
    let trackItem: ParsedTrackItem;
    try {
      trackItem = buildReplacementTrackItem(search.item, search.query, this.view.multipliers.get(search.item.key) ?? 1);
    } catch {
      search.loading = false;
      this.repaint();
      return;
    }
    try {
      const choices = await searchTrackFoodChoices(this.session, trackItem);
      if (this.disposed) {
        return;
      }
      const current = this.view.foodSearch;
      if (!current || current.requestId !== requestId) {
        return;
      }
      current.trackItem = trackItem;
      current.choices = choices;
      current.labels = formatFoodSearchOptionLabels(choices);
      current.cursor = 0;
      current.loading = false;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const current = this.view.foodSearch;
      if (!current || current.requestId !== requestId) {
        return;
      }
      current.loading = false;
      pushMessage(this.view, error instanceof Error ? error.message : String(error));
    }
    this.repaint();
  }

  private toggleCurrentExpansion(): boolean {
    const row = this.currentRow();
    if (!row || rowComponents(this.view, row).length <= 1) {
      return false;
    }
    const key = rowExpansionKey(row);
    this.view.originalMealIndex = null;
    this.view.expandedItemKey = this.view.expandedItemKey === key ? null : key;
    this.repaint();
    return true;
  }

  private toggleCurrentOriginalSection(): boolean {
    if (!canShowOriginalMeal(this.view, this.view.mealCursor)) {
      return false;
    }
    this.view.expandedItemKey = null;
    this.view.originalMealIndex = this.view.originalMealIndex === this.view.mealCursor ? null : this.view.mealCursor;
    this.repaint();
    return true;
  }

  private clearExpandedItem(): void {
    this.view.expandedItemKey = null;
    this.view.originalMealIndex = null;
  }

  private openCurrentAddMode(): void {
    openAddMode(this.view, this.view.mealCursor);
    this.repaint();
  }

  private switchAddFoodTab(delta: number): void {
    const add = this.view.addFood;
    if (!add) {
      return;
    }
    const index = ADD_FOOD_TABS.indexOf(add.tab);
    add.tab = ADD_FOOD_TABS[wrap(index + delta, ADD_FOOD_TABS.length)];
    add.choices = [];
    add.cursor = 0;
    add.loading = true;
    add.requestId += 1;
    const requestId = add.requestId;
    this.repaint();
    void this.refreshAddFood(requestId);
  }

  private updateAddFoodQuery(query: string): void {
    const add = this.view.addFood;
    if (!add) {
      return;
    }
    add.query = query;
    add.choices = [];
    add.cursor = 0;
    add.loading = true;
    add.requestId += 1;
    const requestId = add.requestId;
    if (this.addFoodDebounce) {
      clearTimeout(this.addFoodDebounce);
    }
    this.repaint();
    this.addFoodDebounce = setTimeout(() => void this.refreshAddFood(requestId), 250);
  }

  private async refreshAddFood(requestId: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const add = this.view.addFood;
    if (!add || add.requestId !== requestId) {
      return;
    }
    try {
      const choices = await loadAddFoodChoices(this.session, add);
      if (this.disposed) {
        return;
      }
      const current = this.view.addFood;
      if (!current || current.requestId !== requestId) {
        return;
      }
      current.choices = choices;
      current.cursor = 0;
      current.loading = false;
    } catch (error) {
      if (this.disposed) {
        return;
      }
      const current = this.view.addFood;
      if (!current || current.requestId !== requestId) {
        return;
      }
      current.loading = false;
      pushMessage(this.view, error instanceof Error ? error.message : String(error));
    }
    this.repaint();
  }

  private goBack(): void {
    if (this.view.mode === 'food-search') {
      this.submitAction({ type: 'cancel-food-search' });
      return;
    }
    if (this.view.mode === 'add') {
      closeAddMode(this.view);
      this.repaint();
      return;
    }
    if (this.view.mode === 'assign') {
      this.cancelAssignMode();
      return;
    }
    if (this.view.mode === 'items') {
      this.view.mode = 'meals';
      this.repaint();
      return;
    }
    this.submitAction({ type: 'done' });
  }

  private moveCursor(delta: number): void {
    if (this.view.mode === 'assign') {
      this.moveAssignCursor(delta);
      return;
    }
    if (this.view.mode === 'meals') {
      this.view.mealCursor = wrap(this.view.mealCursor + delta, this.view.meals.length);
      this.view.itemCursor = clamp(this.view.itemCursor, 0, Math.max(0, this.currentMealRows().length - 1));
      return;
    }
    this.view.itemCursor = wrap(this.view.itemCursor + delta, this.currentMealRows().length);
  }

  private moveAssignCursor(delta: number): void {
    const targets = getAssignablePlanItems(this.view);
    if (targets.length === 0) {
      return;
    }
    const currentIndex = targets.findIndex(item =>
      item.mealIndex === this.view.mealCursor && itemRowIndex(this.view, item) === this.view.itemCursor
    );
    const next = targets[wrap((currentIndex === -1 ? 0 : currentIndex) + delta, targets.length)];
    this.view.mealCursor = next.mealIndex;
    this.view.itemCursor = itemRowIndex(this.view, next);
  }

  private moveFoodSearchCursor(delta: number): void {
    const search = this.view.foodSearch;
    if (!search || search.choices.length === 0) {
      return;
    }
    search.cursor = wrap(search.cursor + delta, search.choices.length);
  }

  private moveAddFoodCursor(delta: number): void {
    const add = this.view.addFood;
    if (!add || add.choices.length === 0) {
      return;
    }
    add.cursor = wrap(add.cursor + delta, add.choices.length);
  }

  private submitCurrentToggle(): void {
    if (this.view.mode === 'meals') {
      this.submitAction({ type: 'toggle-meal', mealIndex: this.view.mealCursor });
      return;
    }
    this.submitAction({
      type: 'toggle-row',
      mealIndex: this.view.mealCursor,
      rowIndex: this.view.itemCursor,
    });
  }

  private assignCurrentOutside(): void {
    const row = this.currentRow();
    if (row?.type !== 'plan' || !this.view.assignSource) {
      return;
    }
    assignOutsideTrackedFood(this.cache, this.view, this.view.assignSource, row.item);
    this.repaint();
  }

  private submitCurrentFoodSearch(): void {
    const search = this.view.foodSearch;
    if (!search || search.loading) {
      return;
    }
    this.submitAction({
      type: 'select-food-search',
      index: search.cursor,
    });
  }

  private submitCurrentAddFood(): void {
    const add = this.view.addFood;
    if (!add || add.loading || add.choices.length === 0) {
      return;
    }
    this.submitAction({
      type: 'select-add-food',
      index: add.cursor,
    });
  }

  private submitCurrentEditServing(): boolean {
    const row = this.currentRow();
    if (!rowCanEditServing(this.view, row)) {
      return false;
    }
    this.clearExpandedItem();
    this.submitAction({
      type: 'edit-serving',
      mealIndex: this.view.mealCursor,
      rowIndex: this.view.itemCursor,
    });
    return true;
  }

  private cancelAssignMode(): void {
    const source = this.view.assignSource;
    this.view.mode = 'items';
    this.view.assignSource = null;
    if (source) {
      this.view.mealCursor = source.mealIndex;
      this.view.itemCursor = outsideItemRowIndex(this.view, source);
    }
    this.repaint();
  }

  private submitAction(action: MealPlanPromptAction): void {
    const resolve = this.resolvePrompt;
    if (!resolve) {
      return;
    }
    this.resolvePrompt = null;
    this.cleanupTimers();
    resolve(action);
  }

  private currentRow(): MealPlanRowRef | null {
    return getMealRow(this.view, this.view.mealCursor, this.view.itemCursor);
  }

  private currentMealRows(): MealPlanRowRef[] {
    return getMealRows(this.view, this.view.mealCursor);
  }
}

function ensureKeypressEvents(input: NodeJS.ReadableStream): void {
  if (keypressEventsEnabled) {
    return;
  }
  keypressInterface = createInterface({
    input,
    escapeCodeTimeout: KEYPRESS_ESCAPE_TIMEOUT_MS,
  });
  emitKeypressEvents(input, keypressInterface);
  keypressEventsEnabled = true;
}

function renderMealPlanFrame(state: InteractiveState): string {
  const ingredientLayout = getIngredientLineLayout(state);
  const lines = [
    `${chalk.bold(state.day.day)} ${chalk.gray(`(${state.day.template})`)}${state.dryRun ? chalk.yellow(' dry-run') : ''}`,
    ...formatDailyMacroBalanceLines(state).map(line => `  ${line}`),
    '',
  ];
  for (const [mealIndex, meal] of state.meals.entries()) {
    const activeMeal = (state.mode === 'meals' || state.mode === 'add') && state.mealCursor === mealIndex;
    const mealPrefix = `${activeMeal ? chalk.cyan('>') : ' '} ${formatMealCheckbox(state, meal.items)} ${chalk.bold(meal.meal.meal)} ${chalk.gray(meal.meal.time ?? '')}`;
    const mealLine = `${activeMeal ? chalk.cyan(mealPrefix) : mealPrefix} ${formatMealHeaderMacros(state, mealIndex)}`;
    lines.push(mealLine);
    for (const [itemIndex, item] of meal.items.entries()) {
      const activeItem = (state.mode === 'items' || state.mode === 'assign') && state.mealCursor === mealIndex && state.itemCursor === itemIndex;
      lines.push(renderItemLine(state, item, activeItem, ingredientLayout));
      if (state.expandedItemKey === rowExpansionKey({ type: 'plan', item })) {
        lines.push(...renderExpandedComponentLines(rowComponents(state, { type: 'plan', item }), ingredientLayout));
      }
    }
    for (const [outsideIndex, item] of meal.outsideItems.entries()) {
      const rowIndex = meal.items.length + outsideIndex;
      const activeItem = state.mode === 'items' && state.mealCursor === mealIndex && state.itemCursor === rowIndex;
      lines.push(renderOutsidePlanItemLine(state, item, activeItem, ingredientLayout));
      if (state.expandedItemKey === rowExpansionKey({ type: 'outside', item })) {
        lines.push(...renderExpandedComponentLines(rowComponents(state, { type: 'outside', item }), ingredientLayout));
      }
    }
  }
  lines.push('');
  if (state.meals.some(meal => meal.outsideItems.length > 0)) {
    lines.push(`${chalk.green(OUTSIDE_PLAN_CHECKED)} ${chalk.gray('logged outside plan')}`);
  }
  if (state.foodSearch) {
    lines.push('', ...renderFoodSearchLines(state.foodSearch));
  } else if (state.addFood) {
    lines.push('', ...renderAddFoodLines(state));
  }
  lines.push(chalk.gray(contextHelp(state)));
  for (const message of state.messages.slice(-3)) {
    lines.push(chalk.gray(message));
  }
  return lines.join('\n');
}

function formatDailyMacroBalanceLines(state: InteractiveState): string[] {
  const logged = sumTrackedMacros(state, state.trackedEntries);
  const target = dayTargetMacros(state.day);
  const remaining = subtractMacros(target, logged);
  const widths = getMacroColumnWidths([target, remaining]);
  const labelWidth = visibleLength('target:');
  return [
    `${chalk.gray(padVisibleEnd('left:', labelWidth))} ${formatRemainingMacrosWithWidths(target, remaining, widths)}`,
    `${chalk.gray(padVisibleEnd('target:', labelWidth))} ${formatTargetMacros(target, widths)}`,
  ];
}

function dayTargetMacros(day: EraFitMealPlanDay): EraFitMacroTotals {
  return {
    calories: targetCalories(day),
    protein: day.targets.protein,
    net_carbs: day.targets.net_carbs,
    fat: day.targets.fat,
  };
}

function targetCalories(day: EraFitMealPlanDay): number | null {
  return day.targets.goal_calories ?? day.targets.calories;
}

function sumTrackedMacros(state: InteractiveState, entries: TrackedFoodEntry[]): EraFitMacroTotals {
  return entries.reduce<EraFitMacroTotals>((sum, entry) => {
    const macros = trackedEntryMacroTotals(state, entry);
    return {
      calories: (sum.calories ?? 0) + (macros.calories ?? 0),
      protein: (sum.protein ?? 0) + (macros.protein ?? 0),
      net_carbs: (sum.net_carbs ?? 0) + (macros.net_carbs ?? 0),
      fat: (sum.fat ?? 0) + (macros.fat ?? 0),
    };
  }, { calories: 0, protein: 0, net_carbs: 0, fat: 0 });
}

function mealRemainingMacros(state: InteractiveState, mealIndex: number): EraFitMacroTotals {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return { calories: null, protein: null, net_carbs: null, fat: null };
  }
  return subtractMacros(meal.meal.macros, mealTrackedMacros(state, mealIndex));
}

function formatMealHeaderMacros(state: InteractiveState, mealIndex: number): string {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return formatRemainingMacros(
      { calories: null, protein: null, net_carbs: null, fat: null },
      { calories: null, protein: null, net_carbs: null, fat: null }
    );
  }
  if (isShowingOriginalMeal(state, mealIndex)) {
    const widths = getMacroColumnWidths([meal.meal.macros]);
    return `${chalk.gray('target:')} ${formatTargetMacros(meal.meal.macros, widths)}`;
  }
  return formatRemainingMacros(meal.meal.macros, mealRemainingMacros(state, mealIndex));
}

function mealTrackedMacros(state: InteractiveState, mealIndex: number): EraFitMacroTotals {
  const meal = state.meals[mealIndex];
  if (!meal) {
    return { calories: 0, protein: 0, net_carbs: 0, fat: 0 };
  }
  return sumTrackedMacros(state, state.trackedEntries.filter(entry => entry.meal === meal.trackingMeal));
}

function scaleMacroValue(value: number | null, multiplier: number): number | null {
  return value == null ? null : roundNumber(value * multiplier);
}

function subtractMacros(target: EraFitMacroTotals, consumed: EraFitMacroTotals): EraFitMacroTotals {
  return {
    calories: subtractMacroValue(target.calories, consumed.calories),
    protein: subtractMacroValue(target.protein, consumed.protein),
    net_carbs: subtractMacroValue(target.net_carbs, consumed.net_carbs),
    fat: subtractMacroValue(target.fat, consumed.fat),
  };
}

function subtractMacroValue(target: number | null, consumed: number | null): number | null {
  return target == null ? null : roundRemainingMacroValue(target - (consumed ?? 0));
}

function roundRemainingMacroValue(value: number): number {
  const rounded = Number(value.toFixed(1));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatRemainingMacros(target: EraFitMacroTotals, remaining: EraFitMacroTotals): string {
  const widths = getMacroColumnWidths([target, remaining]);
  return formatRemainingMacrosWithWidths(target, remaining, widths);
}

function formatRemainingMacrosWithWidths(target: EraFitMacroTotals, remaining: EraFitMacroTotals, widths: MacroColumnWidths): string {
  return [
    formatRemainingCalories(target.calories, remaining.calories, widths.calories),
    chalk.gray('|'),
    formatRemainingMacro('P', target.protein, remaining.protein, widths.protein),
    chalk.gray('|'),
    formatRemainingMacro('C', target.net_carbs, remaining.net_carbs, widths.netCarbs),
    chalk.gray('|'),
    formatRemainingMacro('F', target.fat, remaining.fat, widths.fat),
  ].join(' ');
}

function formatTargetMacros(target: EraFitMacroTotals, widths: MacroColumnWidths): string {
  return chalk.gray([
    `${padVisibleStart(formatMacroValue(target.calories), widths.calories)} cal`,
    '|',
    `P ${padVisibleStart(formatMacroValue(target.protein), widths.protein)}`,
    '|',
    `C ${padVisibleStart(formatMacroValue(target.net_carbs), widths.netCarbs)}`,
    '|',
    `F ${padVisibleStart(formatMacroValue(target.fat), widths.fat)}`,
  ].join(' '));
}

function formatRemainingCalories(target: number | null, remaining: number | null, width: number): string {
  return colorRemainingMacro(target, remaining)(`${padVisibleStart(formatMacroValue(remaining), width)} cal`);
}

function formatRemainingMacro(label: string, target: number | null, remaining: number | null, width: number): string {
  return colorRemainingMacro(target, remaining)(`${label} ${padVisibleStart(formatMacroValue(remaining), width)}`);
}

function formatMacroValue(value: number | null): string {
  return value == null ? '-' : formatMacroNumber(value);
}

function colorRemainingMacro(target: number | null, remaining: number | null): (value: string) => string {
  if (target == null || remaining == null) {
    return chalk.gray;
  }
  const tolerance = Math.abs(target) * 0.05;
  if (Math.abs(remaining) <= tolerance) {
    return chalk.green;
  }
  return remaining > 0 ? chalk.yellow : chalk.red;
}

function renderAddFoodLines(state: InteractiveState): string[] {
  const add = state.addFood;
  const meal = add ? state.meals[add.mealIndex] : null;
  if (!add || !meal) {
    return [];
  }
  const lines = [
    `${chalk.cyan('Add')} ${chalk.bold(meal.meal.meal)}`,
    `  ${renderAddFoodTabs(add.tab)}`,
    `  ${chalk.cyan(add.tab === 'search' ? 'Search' : 'Filter')} ${chalk.bold(add.query)}${chalk.inverse(' ')}`,
  ];
  if (add.loading) {
    lines.push(`  ${chalk.yellow(formatLoadingSpinner(`${meal.trackingMeal}:${add.tab}`))} loading ${add.tab}`);
    return lines;
  }
  if (add.tab === 'search' && !add.query.trim()) {
    lines.push(`  ${chalk.gray('type to search global foods')}`);
    return lines;
  }
  if (add.choices.length === 0) {
    lines.push(`  ${chalk.gray('no results')}`);
    return lines;
  }
  const layout = getAddFoodLineLayout(state, add);
  for (const [index, choice] of add.choices.entries()) {
    lines.push(renderAddFoodChoiceLine(choice, index === add.cursor, layout));
  }
  return lines;
}

function renderAddFoodChoiceLine(choice: FoodSearchChoice, active: boolean, layout: IngredientLineLayout): string {
  const label = truncateVisibleEnd(formatAddFoodChoiceLabel(choice), layout.labelWidth);
  const paddedLabel = padVisibleEnd(label, layout.labelWidth);
  const marker = active ? chalk.green('●') : chalk.gray('○');
  const line = `  ${active ? chalk.cyan('>') : ' '}   ${marker} ${paddedLabel}  ${formatMacroColumns(foodSearchChoiceMacroTotals(choice), layout.macroWidths)}`;
  return active ? chalk.cyan(line) : line;
}

function formatAddFoodChoiceLabel(choice: FoodSearchChoice): string {
  return `${formatFoodSearchChoiceName(choice)} ${chalk.gray(`per ${formatFoodSearchChoiceServing(choice)}`)}`;
}

function getAddFoodLineLayout(state: InteractiveState, add: AddFoodState): IngredientLineLayout {
  const sectionLayout = getIngredientLineLayout(state);
  const choiceWidths = getMacroColumnWidths(add.choices.map(foodSearchChoiceMacroTotals));
  const macroWidths = maxMacroColumnWidths(sectionLayout.macroWidths, choiceWidths);
  const macroWidth = visibleLength(formatMacroColumns({ calories: null, protein: null, net_carbs: null, fat: null }, macroWidths));
  const availableLabelWidth = process.stdout.columns
    ? Math.max(18, process.stdout.columns - ITEM_ROW_PREFIX_WIDTH - 2 - macroWidth)
    : sectionLayout.labelWidth;
  return {
    labelWidth: Math.min(sectionLayout.labelWidth, availableLabelWidth),
    macroWidths,
  };
}

function maxMacroColumnWidths(a: MacroColumnWidths, b: MacroColumnWidths): MacroColumnWidths {
  return {
    calories: Math.max(a.calories, b.calories),
    protein: Math.max(a.protein, b.protein),
    netCarbs: Math.max(a.netCarbs, b.netCarbs),
    fat: Math.max(a.fat, b.fat),
  };
}

function renderAddFoodTabs(activeTab: AddFoodTab): string {
  return ADD_FOOD_TABS.map(tab => {
    const label = addFoodTabLabel(tab);
    return tab === activeTab
      ? chalk.bgBlue.white.bold(`[${label}]`)
      : chalk.gray(` ${label} `);
  }).join(' ');
}

function addFoodTabLabel(tab: AddFoodTab): string {
  if (tab === 'past') return 'Past';
  if (tab === 'faves') return 'Faves';
  if (tab === 'meals') return 'Meals';
  if (tab === 'food') return 'Food';
  return 'Search';
}

function renderFoodSearchLines(search: FoodSearchState): string[] {
  const lines = [
    `${chalk.cyan('Search')} ${chalk.bold(search.query)}${chalk.inverse(' ')}`,
  ];
  if (search.loading) {
    lines.push(`  ${chalk.yellow(formatLoadingSpinner(search.item.key))} loading results`);
    return lines;
  }
  if (search.choices.length === 0) {
    lines.push(`  ${chalk.gray('no results')}`);
    return lines;
  }
  for (const [index, label] of search.labels.entries()) {
    const active = index === search.cursor;
    const marker = active ? chalk.green('●') : chalk.gray('○');
    const line = `  ${marker} ${label}`;
    lines.push(active ? chalk.bold(line) : chalk.gray(line));
  }
  return lines;
}

function renderItemLine(state: InteractiveState, item: MealPlanItemRef, active: boolean, layout: IngredientLineLayout): string {
  const completed = state.completedItemKeys.has(item.key);
  const existing = state.existingItemKeys.has(item.key);
  const tracked = state.trackedItemByKey.get(item.key);
  const replacement = tracked && isReplacementTrackedFood(state, item, tracked);
  const showingOriginal = isShowingOriginalMeal(state, item.mealIndex);
  const label = truncateVisibleEnd(formatItemLineLabel(state, item), layout.labelWidth);
  const styledLabel = showingOriginal
    ? chalk.gray(label)
    : completed ? replacement ? chalk.green(label) : chalk.strikethrough(chalk.gray(label))
    : label;
  const existingText = existing ? chalk.gray(' tracked') : '';
  const paddedLabel = padVisibleEnd(styledLabel, layout.labelWidth);
  const macros = completed && tracked && !showingOriginal ? trackedEntryMacroTotals(state, tracked) : item.item;
  const row = { type: 'plan' as const, item };
  const line = `  ${active ? chalk.cyan('>') : ' '} ${formatExpansionMarker(state, row)} ${formatItemCheckbox(state, item)} ${paddedLabel}  ${formatMacroColumns(macros, layout.macroWidths)}${existingText}`;
  return active ? chalk.cyan(line) : line;
}

function renderOutsidePlanItemLine(
  state: InteractiveState,
  item: OutsidePlanItemRef,
  active: boolean,
  layout: IngredientLineLayout
): string {
  const label = truncateVisibleEnd(formatOutsidePlanItemLabel(item), layout.labelWidth);
  const styledLabel = chalk.green(label);
  const paddedLabel = padVisibleEnd(styledLabel, layout.labelWidth);
  const row = { type: 'outside' as const, item };
  const line = `  ${active ? chalk.cyan('>') : ' '} ${formatExpansionMarker(state, row)} ${chalk.green(OUTSIDE_PLAN_CHECKED)} ${paddedLabel}  ${chalk.green(formatMacroColumns(trackedEntryMacroTotals(state, item.entry), layout.macroWidths))}`;
  return line;
}

function renderExpandedComponentLines(components: EraFitMealPlanFoodItem[], layout: IngredientLineLayout): string[] {
  return components.map(component => {
    const label = truncateVisibleEnd(formatComponentItemLabel(component), layout.labelWidth);
    const paddedLabel = padVisibleEnd(chalk.gray(label), layout.labelWidth);
    return `${' '.repeat(ITEM_ROW_PREFIX_WIDTH)}${paddedLabel}  ${formatMacroColumns(component, layout.macroWidths)}`;
  });
}

function getIngredientLineLayout(state: InteractiveState): IngredientLineLayout {
  if (state.renderCache.ingredientLayout) {
    return state.renderCache.ingredientLayout;
  }
  const items = state.meals.flatMap(meal => meal.items);
  const outsideItems = state.meals.flatMap(meal => meal.outsideItems);
  const components = [
    ...items.flatMap(item => mealPlanItemComponents(state, item)),
    ...outsideItems.flatMap(item => trackedEntryComponents(state, item.entry)),
  ];
  const macroWidths = getMacroColumnWidths([
    ...items.map(item => item.item),
    ...outsideItems.map(item => trackedEntryMacroTotals(state, item.entry)),
    ...components,
  ]);
  const naturalLabelWidth = [
    ...items.flatMap(item => formatItemLineLabelsForLayout(state, item)),
    ...outsideItems.map(item => formatOutsidePlanItemLabel(item)),
    ...components.map(component => formatComponentItemLabel(component)),
  ].reduce((width, label) => Math.max(width, visibleLength(label)), 0);
  const macroWidth = visibleLength(formatMacroColumns({ calories: null, protein: null, net_carbs: null, fat: null }, macroWidths));
  const trackedWidth = items.some(item => state.existingItemKeys.has(item.key)) ? visibleLength(' tracked') : 0;
  const availableLabelWidth = process.stdout.columns
    ? Math.max(18, process.stdout.columns - ITEM_ROW_PREFIX_WIDTH - 2 - macroWidth - trackedWidth)
    : naturalLabelWidth;
  state.renderCache.ingredientLayout = {
    labelWidth: Math.min(naturalLabelWidth, availableLabelWidth),
    macroWidths,
  };
  return state.renderCache.ingredientLayout;
}

function formatExpansionMarker(state: InteractiveState, row: MealPlanRowRef): string {
  if (rowComponents(state, row).length <= 1) {
    return ' ';
  }
  return state.expandedItemKey === rowExpansionKey(row)
    ? chalk.cyan(EXPAND_EXPANDED)
    : chalk.gray(EXPAND_COLLAPSED);
}

function rowComponents(state: InteractiveState, row: MealPlanRowRef): EraFitMealPlanFoodItem[] {
  return row.type === 'plan'
    ? mealPlanItemComponents(state, row.item)
    : trackedEntryComponents(state, row.item.entry);
}

function rowExpansionKey(row: MealPlanRowRef): string {
  return `${row.type}:${row.item.key}`;
}

function mealPlanItemComponents(state: InteractiveState, item: MealPlanItemRef): EraFitMealPlanFoodItem[] {
  const tracked = state.trackedItemByKey.get(item.key);
  const trackedComponents = tracked ? trackedEntryComponents(state, tracked) : [];
  return trackedComponents.length > 1 ? trackedComponents : item.item.components ?? trackedComponents;
}

function trackedEntryComponents(state: InteractiveState, entry: TrackedFoodEntry): EraFitMealPlanFoodItem[] {
  const key = trackedEntryKey(entry);
  const cached = state.renderCache.trackedComponents.get(key);
  if (cached) {
    return cached;
  }
  const components = trackedFoodComponents(entry.record);
  state.renderCache.trackedComponents.set(key, components);
  return components;
}

function trackedFoodComponents(record: TrackedFoodRecord): EraFitMealPlanFoodItem[] {
  const raw = record as unknown as Record<string, unknown>;
  const foods = raw.foods;
  const records = Array.isArray(foods)
    ? foods
    : Object.values(asRecord(foods) ?? {});
  const multiplier = parseNumberLike(raw.serving_qtd) ?? 1;
  return records
    .map(component => trackedFoodComponent(component, multiplier))
    .filter((component): component is EraFitMealPlanFoodItem => component != null);
}

function trackedEntryMacroTotals(state: InteractiveState, entry: TrackedFoodEntry): EraFitMealPlanFoodItem {
  const key = trackedEntryKey(entry);
  const cached = state.renderCache.trackedMacroTotals.get(key);
  if (cached) {
    return cached;
  }
  const totals = trackedMacroTotals(entry.record);
  state.renderCache.trackedMacroTotals.set(key, totals);
  return totals;
}

function trackedFoodComponent(value: unknown, multiplier: number): EraFitMealPlanFoodItem | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  const name = nonEmptyString(raw.food_name) ?? nonEmptyString(raw.title) ?? nonEmptyString(raw.name);
  if (!name) {
    return null;
  }
  const serving = nonEmptyString(raw.serving_description) ?? buildComponentServing(raw);
  const amount =
    parseNumberLike(raw.metric_serving_amount) ??
    parseNumberLike(raw.serving_qtd) ??
    parseNumberLike(raw.amount_g) ??
    parseNumberLike(raw.amount);
  const unit =
    nonEmptyString(raw.metric_serving_unit) ??
    nonEmptyString(raw.serving_unit) ??
    (parseNumberLike(raw.amount_g) != null ? 'g' : null);
  return {
    name,
    description: serving ? `${serving} ${name}` : name,
    amount: amount == null ? null : roundNumber(amount * multiplier),
    unit,
    serving,
    calories: scaleMacroValue(parseNumberLike(raw.energy) ?? parseNumberLike(raw.calories), multiplier),
    protein: scaleMacroValue(parseNumberLike(raw.protein), multiplier),
    net_carbs: scaleMacroValue(parseNetCarbsValue(raw.net_carbs, raw.carbohydrate), multiplier),
    fat: scaleMacroValue(parseNumberLike(raw.fat), multiplier),
  };
}

function buildComponentServing(raw: Record<string, unknown>): string | null {
  const quantity = parseNumberLike(raw.serving_qtd);
  const unit = nonEmptyString(raw.serving_unit) ?? nonEmptyString(raw.unit);
  return [quantity == null ? null : formatNumber(quantity), unit].filter(Boolean).join(' ') || null;
}

function formatComponentItemLabel(component: EraFitMealPlanFoodItem): string {
  return component.description?.trim() || component.name;
}

function formatInteractiveItemLabel(state: InteractiveState, item: MealPlanItemRef): string {
  const multiplier = state.multipliers.get(item.key);
  return `${formatItemDisplayName(item.item)}${multiplier && Math.abs(multiplier - 1) > 0.0001 ? ` x${formatNumber(multiplier)}` : ''}`;
}

function formatItemLineLabel(state: InteractiveState, item: MealPlanItemRef): string {
  const tracked = state.trackedItemByKey.get(item.key);
  return tracked && state.completedItemKeys.has(item.key) && isReplacementTrackedFood(state, item, tracked) && !isShowingOriginalMeal(state, item.mealIndex)
    ? formatTrackedPlanItemLabel(tracked.record)
    : formatInteractiveItemLabel(state, item);
}

function formatItemLineLabelsForLayout(state: InteractiveState, item: MealPlanItemRef): string[] {
  const labels = [formatInteractiveItemLabel(state, item)];
  const tracked = state.trackedItemByKey.get(item.key);
  if (tracked && isReplacementTrackedFood(state, item, tracked)) {
    labels.push(formatTrackedPlanItemLabel(tracked.record));
  }
  return labels;
}

function isShowingOriginalMeal(state: InteractiveState, mealIndex: number): boolean {
  return state.originalMealIndex === mealIndex;
}

function canShowOriginalMeal(state: InteractiveState, mealIndex: number): boolean {
  const meal = state.meals[mealIndex];
  return Boolean(meal?.items.some(item => {
    const tracked = state.trackedItemByKey.get(item.key);
    return tracked && isReplacementTrackedFood(state, item, tracked);
  }));
}

function formatOutsidePlanItemLabel(item: OutsidePlanItemRef): string {
  return formatTrackedPlanItemLabel(item.entry.record);
}

function formatTrackedPlanItemLabel(record: TrackedFoodRecord): string {
  const serving = nonEmptyString(record.serving_description);
  const name = formatTrackedFoodDisplayName(record);
  return serving ? `${name} (${serving})` : name;
}

function isReplacementTrackedFood(state: InteractiveState, item: MealPlanItemRef, tracked: TrackedFoodEntry): boolean {
  return normalizeFoodCacheKey(formatInteractiveItemLabel(state, item)) !==
    normalizeFoodCacheKey(formatTrackedPlanItemLabel(tracked.record));
}

function formatTrackedFoodDisplayName(record: TrackedFoodRecord): string {
  return nonEmptyString(record.food_name) ?? 'Logged food';
}

function trackedMacroTotals(record: TrackedFoodRecord): EraFitMealPlanFoodItem {
  return {
    name: formatTrackedFoodDisplayName(record),
    description: null,
    amount: null,
    unit: null,
    serving: null,
    calories: parseNumberLike(record.energy) ?? parseNumberLike(record.calories),
    protein: parseNumberLike(record.protein),
    net_carbs: parseNetCarbsValue(record.net_carbs, record.carbohydrate),
    fat: parseNumberLike(record.fat),
  };
}

function formatMealCheckbox(state: InteractiveState, items: MealPlanItemRef[]): string {
  const loading = items.find(item => state.loadingItemKeys.has(item.key));
  if (loading) {
    return formatLoadingSpinner(loading.key);
  }
  const checked = items.filter(item => state.completedItemKeys.has(item.key)).length;
  if (checked === 0) return CHECKBOX_EMPTY;
  if (checked === items.length) return CHECKBOX_CHECKED;
  return CHECKBOX_PARTIAL;
}

function formatItemCheckbox(state: InteractiveState, item: MealPlanItemRef): string {
  if (state.loadingItemKeys.has(item.key)) {
    return formatLoadingSpinner(item.key);
  }
  if (state.mode === 'assign') {
    if (state.completedItemKeys.has(item.key)) {
      return CHECKBOX_CHECKED;
    }
    return state.mealCursor === item.mealIndex && state.itemCursor === itemRowIndex(state, item)
      ? chalk.cyan(ASSIGN_POINTER)
      : ' ';
  }
  return state.completedItemKeys.has(item.key) ? CHECKBOX_CHECKED : CHECKBOX_EMPTY;
}

function formatLoadingSpinner(key: string): string {
  const offset = Array.from(key).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const index = Math.floor(Date.now() / 120 + offset) % LOADING_FRAMES.length;
  return chalk.yellow(LOADING_FRAMES[index]);
}

function contextHelp(state: InteractiveState): string {
  if (state.mode === 'meals') {
    const originalAction = canShowOriginalMeal(state, state.mealCursor)
      ? ` | O ${isShowingOriginalMeal(state, state.mealCursor) ? 'current' : 'original'}`
      : '';
    return `↑/↓ meals | → items | ␣ toggle | A add${originalAction} | Esc/q exit | Ctrl-C cancel`;
  }
  if (state.mode === 'assign') {
    return '↑/↓ unchecked | ␣/A assign | ←/Esc cancel | q exit';
  }
  if (state.mode === 'food-search') {
    return 'type search | ↑/↓ results | Enter select | Esc cancel | Ctrl-C exit';
  }
  if (state.mode === 'add') {
    return '←/→ tabs | type search/filter | ↑/↓ results | Enter add | Esc meals | Ctrl-C exit';
  }
  const row = getMealRow(state, state.mealCursor, state.itemCursor);
  const editAction = rowCanEditServing(state, row) ? ' | E edit' : '';
  const expandAction = !editAction && row && rowComponents(state, row).length > 1
    ? ` | E ${state.expandedItemKey === rowExpansionKey(row) ? 'collapse' : 'expand'}`
    : '';
  return row?.type === 'outside'
    ? `↑/↓ items | ←/Esc meals | A assign${editAction}${expandAction} | q exit`
    : `↑/↓ items | ←/Esc meals | ␣ toggle | R serving | S alternative${editAction}${expandAction} | q exit`;
}

function formatItemDisplayName(item: EraFitMealPlanFoodItem): string {
  return item.description?.trim() || item.name;
}

function clearInteractiveScreen(output: NodeJS.WritableStream = process.stdout): void {
  output.write('\x1b[H\x1b[J');
}

function pushMessage(state: InteractiveState, message: string): void {
  state.messages.push(message);
  if (state.messages.length > 8) {
    state.messages.splice(0, state.messages.length - 8);
  }
}

function wrap(value: number, length: number): number {
  if (length <= 0) return 0;
  if (value < 0) return length - 1;
  if (value >= length) return 0;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
