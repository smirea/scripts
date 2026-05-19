import { isCancel, Prompt, settings as clackSettings } from '@clack/core';
import { isCancel as isPromptCancel, text } from '@clack/prompts';
import chalk from 'chalk';

import { type EraFitCache } from './cache';
import {
  formatDateKey,
  formatEraFitDateId,
  formatNumber,
  parseNumberLike,
  roundNumber,
  startOfLocalDay,
  uniqueStrings,
  type EraFitMacroTotals,
  type EraFitMealKey,
  type EraFitMealPlanDay,
  type EraFitMealPlanFoodItem,
  type EraFitMealPlanMeal,
  type EraFitSession,
} from './core';
import {
  deleteTrackedFoods,
  fetchTrackedFoodsForDate,
  formatEraFitTime,
  parseTrackItem,
  resolveTrackFood,
  saveTrackedFoods,
  tryParseTrackItem,
  type ParsedTrackItem,
  type ResolvedTrackFood,
  type SavedTrackFood,
  type TrackedFoodEntry,
  type TrackedFoodRecord,
} from './tracking';

type NavigationMode = 'meals' | 'items';
type LoadingKind = 'checking' | 'unchecking';

const CHECKBOX_EMPTY = '○';
const CHECKBOX_CHECKED = '⊗';
const CHECKBOX_PARTIAL = '⊝';
const LOADING_FRAMES = ['◐', '◓', '◑', '◒'];

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

interface InteractiveState {
  day: EraFitMealPlanDay;
  meals: Array<{
    meal: EraFitMealPlanMeal;
    trackingMeal: EraFitMealKey;
    items: MealPlanItemRef[];
  }>;
  dryRun: boolean;
  mode: NavigationMode;
  mealCursor: number;
  itemCursor: number;
  completedItemKeys: Set<string>;
  existingItemKeys: Set<string>;
  trackedItemByKey: Map<string, TrackedFoodEntry>;
  loadingItemKeys: Map<string, LoadingKind>;
  tasks: Set<Promise<void>>;
  multipliers: Map<string, number>;
  pendingSearchItems: MealPlanItemRef[];
  messages: string[];
}

type MealPlanPromptAction =
  | { type: 'toggle-meal'; mealIndex: number }
  | { type: 'toggle-item'; mealIndex: number; itemIndex: number }
  | { type: 'set-serving'; mealIndex: number; itemIndex: number }
  | { type: 'switch-alternative'; mealIndex: number; itemIndex: number }
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
    const action = await promptMealPlanChecklist(state);
    if (isCancel(action) || !action || action.type === 'done') {
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

async function promptMealPlanChecklist(state: InteractiveState): Promise<symbol | MealPlanPromptAction | undefined> {
  const previousEscape = clackSettings.aliases.get('escape');
  clackSettings.aliases.delete('escape');
  try {
    return await new MealPlanChecklistPrompt(state).prompt();
  } finally {
    if (previousEscape) {
      clackSettings.aliases.set('escape', previousEscape);
    }
  }
}

function createInteractiveState(
  day: EraFitMealPlanDay,
  cache: EraFitCache,
  tracked: TrackedFoodEntry[],
  dryRun: boolean
): InteractiveState {
  const meals = day.meals.map((meal, mealIndex) => {
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
    };
  });
  const matched = matchExistingTrackedItems(meals, tracked);
  return {
    day,
    meals,
    dryRun,
    mode: 'meals',
    mealCursor: 0,
    itemCursor: 0,
    completedItemKeys: matched.completed,
    existingItemKeys: new Set(matched.completed),
    trackedItemByKey: matched.trackedByItemKey,
    loadingItemKeys: new Map(),
    tasks: new Set(),
    multipliers: new Map(),
    pendingSearchItems: [],
    messages: [],
  };
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
  if (action.type === 'toggle-meal') {
    const meal = state.meals[action.mealIndex];
    startToggleItemsTask(session, cache, dateId, state, meal.items);
    return;
  }
  if (action.type === 'done') {
    return;
  }
  const item = state.meals[action.mealIndex]?.items[action.itemIndex];
  if (!item) {
    return;
  }
  if (action.type === 'toggle-item') {
    startToggleItemsTask(session, cache, dateId, state, [item]);
    return;
  }
  clearInteractiveScreen();
  if (action.type === 'set-serving') {
    await promptServingMultiplier(state, item);
    return;
  }
  await promptReplacementAndLog(session, cache, dateId, state, item);
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
  pushMessage(state, `${formatItemDisplayName(item.item)} multiplier set to ${formatNumber(multiplier)}x`);
  state.mode = 'items';
}

async function promptReplacementAndLog(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  item: MealPlanItemRef
): Promise<void> {
  if (state.completedItemKeys.has(item.key)) {
    pushMessage(state, `${formatItemDisplayName(item.item)} is already checked`);
    return;
  }
  const value = await text({
    message: `Search name, barcode, or food id for ${formatItemDisplayName(item.item)}`,
    placeholder: item.item.name,
    validate(input) {
      return input?.trim() ? undefined : 'Enter a search, barcode, or food id.';
    },
  });
  if (isPromptCancel(value)) {
    state.mode = 'meals';
    pushMessage(state, 'alternative unchanged');
    return;
  }
  await logMealItems(session, cache, dateId, state, [item], {
    replacement: value.trim(),
    interactive: true,
  });
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

  let saved: SavedTrackFood[] = [];
  if (!state.dryRun) {
    saved = await saveTrackedFoods(session, {
      dateId,
      meal: resolved[0].item.trackingMeal,
      foods: resolved.map(entry => entry.food),
    });
  }

  for (const [index, entry] of resolved.entries()) {
    state.completedItemKeys.add(entry.item.key);
    state.existingItemKeys.delete(entry.item.key);
    const savedFood = saved[index];
    if (savedFood) {
      state.trackedItemByKey.set(entry.item.key, {
        meal: entry.item.trackingMeal,
        id: savedFood.id,
        record: savedFood.record,
      });
    }
  }
  const label = resolved.length === 1
    ? formatItemDisplayName(resolved[0].item.item)
    : `${resolved.length} items`;
  pushMessage(state, `${state.dryRun ? 'would log' : 'logged'} ${label}`);
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
  meals: InteractiveState['meals'],
  tracked: TrackedFoodEntry[]
): {
  completed: Set<string>;
  trackedByItemKey: Map<string, TrackedFoodEntry>;
} {
  const completed = new Set<string>();
  const trackedByItemKey = new Map<string, TrackedFoodEntry>();
  const used = new Set<string>();
  for (const meal of meals) {
    const candidates = tracked.filter(entry => entry.meal === meal.trackingMeal);
    for (const item of meal.items) {
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
  return { completed, trackedByItemKey };
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

class MealPlanChecklistPrompt extends Prompt<MealPlanPromptAction> {
  private readonly repaintTimer: ReturnType<typeof setInterval>;

  constructor(private readonly view: InteractiveState) {
    super({
      render() {
        return renderMealPlanFrame(view);
      },
    }, false);
    this.repaintTimer = setInterval(() => {
      const pendingSearch = this.view.pendingSearchItems.shift();
      if (pendingSearch) {
        this.view.mode = 'items';
        this.view.mealCursor = pendingSearch.mealIndex;
        this.view.itemCursor = pendingSearch.itemIndex;
        this.submitAction({
          type: 'switch-alternative',
          mealIndex: pendingSearch.mealIndex,
          itemIndex: pendingSearch.itemIndex,
        });
        return;
      }
      this.repaint();
    }, 120);
    this.once('submit', () => clearInterval(this.repaintTimer));
    this.once('cancel', () => clearInterval(this.repaintTimer));
    this.on('cursor', action => {
      if (action === 'up' || action === 'down') {
        this.moveCursor(action === 'up' ? -1 : 1);
      } else if (action === 'right' && this.view.mode === 'meals') {
        this.view.mode = 'items';
        this.view.itemCursor = clamp(this.view.itemCursor, 0, Math.max(0, this.currentMealItems().length - 1));
      } else if (action === 'left' && this.view.mode === 'items') {
        this.view.mode = 'meals';
      } else if (action === 'space') {
        this.submitCurrentToggle();
      }
    });
    this.on('key', (key, info) => {
      if (info.name === 'escape') {
        this.goBack();
      } else if (key === 'q') {
        this.submitAction({ type: 'done' });
      } else if (key === 's' && this.view.mode === 'items') {
        this.submitAction({
          type: 'switch-alternative',
          mealIndex: this.view.mealCursor,
          itemIndex: this.view.itemCursor,
        });
      } else if (key === 'r' && this.view.mode === 'items') {
        this.submitAction({
          type: 'set-serving',
          mealIndex: this.view.mealCursor,
          itemIndex: this.view.itemCursor,
        });
      }
    });
  }

  private repaint(): void {
    (this as unknown as { render(): void }).render();
  }

  private goBack(): void {
    if (this.view.mode === 'items') {
      this.view.mode = 'meals';
      this.repaint();
      return;
    }
    this.submitAction({ type: 'done' });
  }

  private moveCursor(delta: number): void {
    if (this.view.mode === 'meals') {
      this.view.mealCursor = wrap(this.view.mealCursor + delta, this.view.meals.length);
      this.view.itemCursor = clamp(this.view.itemCursor, 0, Math.max(0, this.currentMealItems().length - 1));
      return;
    }
    this.view.itemCursor = wrap(this.view.itemCursor + delta, this.currentMealItems().length);
  }

  private submitCurrentToggle(): void {
    if (this.view.mode === 'meals') {
      this.submitAction({ type: 'toggle-meal', mealIndex: this.view.mealCursor });
      return;
    }
    this.submitAction({
      type: 'toggle-item',
      mealIndex: this.view.mealCursor,
      itemIndex: this.view.itemCursor,
    });
  }

  private submitAction(action: MealPlanPromptAction): void {
    this.value = action;
    this.state = 'submit';
    this.emit('submit');
  }

  private currentMealItems(): MealPlanItemRef[] {
    return this.view.meals[this.view.mealCursor]?.items ?? [];
  }
}

function renderMealPlanFrame(state: InteractiveState): string {
  const lines = [
    `${chalk.bold(state.day.day)} ${chalk.gray(`(${state.day.template})`)}${state.dryRun ? chalk.yellow(' dry-run') : ''}`,
    `  ${formatMacros(state.day.planned)} ${chalk.gray('| target')} ${formatMacros(state.day.targets)}`,
    '',
  ];
  for (const [mealIndex, meal] of state.meals.entries()) {
    const activeMeal = state.mode === 'meals' && state.mealCursor === mealIndex;
    const mealLine = `${activeMeal ? chalk.cyan('>') : ' '} ${formatMealCheckbox(state, meal.items)} ${chalk.bold(meal.meal.meal)} ${chalk.gray(meal.meal.time ?? '')} ${formatMacros(meal.meal.macros)}`;
    lines.push(activeMeal ? chalk.cyan(mealLine) : mealLine);
    for (const [itemIndex, item] of meal.items.entries()) {
      const activeItem = state.mode === 'items' && state.mealCursor === mealIndex && state.itemCursor === itemIndex;
      lines.push(renderItemLine(state, item, activeItem));
    }
  }
  lines.push('');
  lines.push(chalk.gray(contextHelp(state.mode)));
  for (const message of state.messages.slice(-3)) {
    lines.push(chalk.gray(message));
  }
  return lines.join('\n');
}

function renderItemLine(state: InteractiveState, item: MealPlanItemRef, active: boolean): string {
  const completed = state.completedItemKeys.has(item.key);
  const existing = state.existingItemKeys.has(item.key);
  const multiplier = state.multipliers.get(item.key);
  const label = formatItemDisplayName(item.item);
  const styledLabel = completed
    ? chalk.strikethrough(chalk.gray(label))
    : label;
  const multiplierText = multiplier && Math.abs(multiplier - 1) > 0.0001
    ? chalk.cyan(` x${formatNumber(multiplier)}`)
    : '';
  const existingText = existing ? chalk.gray(' tracked') : '';
  const line = `  ${active ? chalk.cyan('>') : ' '} ${formatItemCheckbox(state, item)} ${styledLabel}${multiplierText} ${formatMacros(item.item)}${existingText}`;
  return active ? chalk.cyan(line) : line;
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
  return state.completedItemKeys.has(item.key) ? CHECKBOX_CHECKED : CHECKBOX_EMPTY;
}

function formatLoadingSpinner(key: string): string {
  const offset = Array.from(key).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const index = Math.floor(Date.now() / 120 + offset) % LOADING_FRAMES.length;
  return chalk.yellow(LOADING_FRAMES[index]);
}

function contextHelp(mode: NavigationMode): string {
  return mode === 'meals'
    ? '↑/↓ meals | → items | Space toggle | Esc/q exit | Ctrl-C cancel'
    : '↑/↓ items | ←/Esc meals | Space toggle | R serving | S alternative | q exit';
}

function formatItemDisplayName(item: EraFitMealPlanFoodItem): string {
  return item.description?.trim() || item.name;
}

function formatMacros(value: EraFitMacroTotals): string {
  return [
    chalk.blue(`${formatNullableNumber(value.calories)} kcal`),
    chalk.red(`P ${formatNullableNumber(value.protein)}g`),
    chalk.yellow(`C ${formatNullableNumber(value.net_carbs)}g`),
    chalk.magenta(`F ${formatNullableNumber(value.fat)}g`),
  ].join(chalk.gray(' | '));
}

function formatNullableNumber(value: number | null): string {
  return value == null ? '-' : formatNumber(roundNumber(value));
}

function clearInteractiveScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
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
