import { isCancel, Prompt } from '@clack/core';
import { isCancel as isPromptCancel, select, text } from '@clack/prompts';
import chalk from 'chalk';

import { type EraFitCache } from './cache';
import {
  formatDateKey,
  formatEraFitDateId,
  formatNumber,
  parseNumberLike,
  roundNumber,
  startOfLocalDay,
  type EraFitMacroTotals,
  type EraFitMealKey,
  type EraFitMealPlanDay,
  type EraFitMealPlanFoodItem,
  type EraFitMealPlanMeal,
  type EraFitSession,
} from './core';
import {
  fetchTrackedFoodsForDate,
  formatEraFitTime,
  parseTrackItem,
  resolveTrackFood,
  saveTrackedFoods,
  tryParseTrackItem,
  type ParsedTrackItem,
  type ResolvedTrackFood,
  type TrackedFoodEntry,
  type TrackedFoodRecord,
} from './tracking';

type NavigationMode = 'meals' | 'items';

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
  multipliers: Map<string, number>;
  messages: string[];
}

type MealPlanPromptAction =
  | { type: 'toggle-meal'; mealIndex: number }
  | { type: 'toggle-item'; mealIndex: number; itemIndex: number }
  | { type: 'item-action'; mealIndex: number; itemIndex: number }
  | { type: 'done' };

export async function runInteractiveTodayMealPlan(options: InteractiveMealPlanOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive mealplan mode requires a TTY. Use --format=json or omit --today for noninteractive output.');
  }

  const date = startOfLocalDay(new Date());
  const dateId = formatEraFitDateId(date);
  const tracked = await fetchTrackedFoodsForDate(options.session, dateId);
  const state = createInteractiveState(options.day, options.cache, tracked, options.dryRun);
  pushMessage(state, options.dryRun
    ? `dry run for ${formatDateKey(date)}; no Era Fit writes or cache updates`
    : `tracking ${formatDateKey(date)}`);

  while (true) {
    const action = await new MealPlanChecklistPrompt(state).prompt();
    if (isCancel(action) || !action || action.type === 'done') {
      process.stdout.write(chalk.gray('done\n'));
      return;
    }
    await handleMealPlanAction(options.session, options.cache, dateId, state, action);
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
  const completedItemKeys = matchExistingTrackedItems(meals, tracked);
  return {
    day,
    meals,
    dryRun,
    mode: 'meals',
    mealCursor: 0,
    itemCursor: 0,
    completedItemKeys,
    existingItemKeys: new Set(completedItemKeys),
    multipliers: new Map(),
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
    await logMealItems(session, cache, dateId, state, meal.items);
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
    await logMealItems(session, cache, dateId, state, [item]);
    return;
  }
  await handleItemAction(session, cache, dateId, state, item);
}

async function handleItemAction(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  item: MealPlanItemRef
): Promise<void> {
  const action = await select({
    message: `Action for ${formatItemDisplayName(item.item)}`,
    options: [
      { value: 'replace', label: 'Replace/search and log' },
      { value: 'multiplier', label: 'Set serving multiplier' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (isPromptCancel(action) || action === 'cancel') {
    pushMessage(state, 'cancelled item action');
    return;
  }
  if (action === 'multiplier') {
    await promptServingMultiplier(state, item);
    return;
  }
  await promptReplacementAndLog(session, cache, dateId, state, item);
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
    pushMessage(state, 'cancelled multiplier');
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
    pushMessage(state, 'cancelled replacement');
    return;
  }
  await logMealItems(session, cache, dateId, state, [item], value.trim());
}

async function logMealItems(
  session: EraFitSession,
  cache: EraFitCache,
  dateId: string,
  state: InteractiveState,
  items: MealPlanItemRef[],
  replacement?: string
): Promise<void> {
  const pending = items.filter(item => !state.completedItemKeys.has(item.key));
  if (pending.length === 0) {
    pushMessage(state, 'everything selected is already checked');
    return;
  }

  const resolved: Array<{ item: MealPlanItemRef; food: ResolvedTrackFood }> = [];
  for (const item of pending) {
    const trackItem = replacement
      ? buildReplacementTrackItem(item, replacement, state.multipliers.get(item.key) ?? 1)
      : buildMealPlanTrackItem(item, state.multipliers.get(item.key) ?? 1);
    const result = await resolveTrackFood(
      session,
      cache,
      trackItem,
      formatEraFitTime(new Date()),
      {
        useCache: true,
        writeCache: !state.dryRun,
        log: message => pushMessage(state, message),
      }
    ).catch(error => {
      pushMessage(state, error instanceof Error ? error.message : String(error));
      return null;
    });
    if (!result) {
      continue;
    }
    if (result.status === 'cancel') {
      pushMessage(state, 'cancelled logging');
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

  if (!state.dryRun) {
    await saveTrackedFoods(session, {
      dateId,
      meal: resolved[0].item.trackingMeal,
      foods: resolved.map(entry => entry.food),
    });
  }

  for (const entry of resolved) {
    state.completedItemKeys.add(entry.item.key);
  }
  const label = resolved.length === 1
    ? formatItemDisplayName(resolved[0].item.item)
    : `${resolved.length} items`;
  pushMessage(state, `${state.dryRun ? 'would log' : 'logged'} ${label}`);
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
): Set<string> {
  const completed = new Set<string>();
  const used = new Set<string>();
  for (const meal of meals) {
    const candidates = tracked.filter(entry => entry.meal === meal.trackingMeal);
    for (const item of meal.items) {
      const scored = candidates
        .filter(entry => !used.has(`${entry.meal}:${entry.id}`))
        .map(entry => ({
          entry,
          score: scoreTrackedMatch(item.item, entry.record),
        }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best || best.score < 4) {
        continue;
      }
      completed.add(item.key);
      used.add(`${best.entry.meal}:${best.entry.id}`);
    }
  }
  return completed;
}

function scoreTrackedMatch(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): number {
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

  const macroDistance = macroMatchDistance(item, record);
  if (macroDistance <= 8) score += 4;
  else if (macroDistance <= 18) score += 2;

  const itemGrams = item.unit === 'g' ? item.amount : null;
  const recordGrams = trackedRecordGrams(record);
  if (itemGrams != null && recordGrams != null) {
    const difference = Math.abs(itemGrams - recordGrams);
    if (difference <= Math.max(8, itemGrams * 0.08)) score += 3;
    else if (difference <= Math.max(25, itemGrams * 0.18)) score += 1;
  }
  return score;
}

function macroMatchDistance(item: EraFitMealPlanFoodItem, record: TrackedFoodRecord): number {
  return [
    Math.abs((item.calories ?? 0) - (record.calories ?? 0)) / 8,
    Math.abs((item.protein ?? 0) - (record.protein ?? 0)),
    Math.abs((item.net_carbs ?? 0) - (record.carbohydrate ?? 0)),
    Math.abs((item.fat ?? 0) - (record.fat ?? 0)),
  ].reduce((sum, value) => sum + value, 0);
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
  constructor(private readonly view: InteractiveState) {
    super({
      render() {
        return renderMealPlanFrame(view);
      },
    }, false);
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
    this.on('key', key => {
      if (key === 'q') {
        this.submitAction({ type: 'done' });
      } else if (key === 's' && this.view.mode === 'items') {
        this.submitAction({
          type: 'item-action',
          mealIndex: this.view.mealCursor,
          itemIndex: this.view.itemCursor,
        });
      }
    });
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
  const line = `  ${active ? chalk.cyan('>') : ' '} ${completed ? '[x]' : '[ ]'} ${styledLabel}${multiplierText} ${formatMacros(item.item)}${existingText}`;
  return active ? chalk.cyan(line) : line;
}

function formatMealCheckbox(state: InteractiveState, items: MealPlanItemRef[]): string {
  const checked = items.filter(item => state.completedItemKeys.has(item.key)).length;
  if (checked === 0) return '[ ]';
  if (checked === items.length) return '[x]';
  return '[-]';
}

function contextHelp(mode: NavigationMode): string {
  return mode === 'meals'
    ? 'up/down move meals | right enter meal | space log meal | enter/q done | ctrl+c cancel'
    : 'up/down move items | left meals | space log item | s replace or multiplier | enter/q done | ctrl+c cancel';
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
