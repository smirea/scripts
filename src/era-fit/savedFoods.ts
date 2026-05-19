import { normalizeFoodCacheKey, type CachedFoodSelection } from './cache';
import { formatNumber, parseNumberLike, readEraFitFirebasePath, type EraFitSession } from './core';

export type SavedFoodSource = 'favorite' | 'custom_food' | 'my_meal';

export interface SavedFoodSearchItem {
  source: SavedFoodSource;
  id: string;
  foodId?: string;
  customFoodId?: string;
  name: string;
  brandName?: string;
  servingDescription: string;
  servingQuantity: number;
  servingUnit: string;
  calories: number;
  protein: number;
  carbohydrate: number;
  fat: number;
  timestamp: number;
  raw: Record<string, unknown>;
}

export async function searchSavedFoods(session: EraFitSession, query: string): Promise<SavedFoodSearchItem[]> {
  const candidates = await listSavedFoods(session);
  const scored = candidates
    .map(food => ({ food, score: scoreSavedFoodMatch(food, query) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      savedFoodSourceRank(a.food.source) - savedFoodSourceRank(b.food.source) ||
      b.food.timestamp - a.food.timestamp ||
      a.food.name.localeCompare(b.food.name)
    );
  return dedupeSavedFoods(scored.map(entry => entry.food));
}

export async function listSavedFoods(session: EraFitSession): Promise<SavedFoodSearchItem[]> {
  const basePath = `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress`;
  const [favorites, customFoods, meals] = await Promise.all([
    readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/my_foods`),
    readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/my_customized_food`),
    readEraFitFirebasePath<Record<string, unknown>>(session, `${basePath}/my_meals`),
  ]);
  return [
    ...parseSavedFoodCollection(favorites, 'favorite'),
    ...parseSavedFoodCollection(customFoods, 'custom_food'),
    ...parseSavedFoodCollection(meals, 'my_meal'),
  ];
}

export async function findSavedFoodFromCache(
  session: EraFitSession,
  cached: CachedFoodSelection
): Promise<SavedFoodSearchItem | null> {
  if (cached.servingType !== 'saved') {
    return null;
  }
  const savedFoods = await listSavedFoods(session);
  const sourceMatches = (food: SavedFoodSearchItem) => !cached.savedSource || food.source === cached.savedSource;
  return savedFoods.find(food =>
    sourceMatches(food) && cached.savedId && food.id === cached.savedId
  ) ?? savedFoods.find(food =>
    sourceMatches(food) && cached.customFoodId && food.customFoodId === cached.customFoodId
  ) ?? savedFoods.find(food =>
    sourceMatches(food) && cached.foodId && (food.foodId === cached.foodId || food.id === cached.foodId)
  ) ?? savedFoods.find(food =>
    sourceMatches(food) && normalizeFoodCacheKey(food.name) === normalizeFoodCacheKey(cached.foodName)
  ) ?? null;
}

export function savedFoodSourceLabel(source: SavedFoodSource): string {
  if (source === 'favorite') return 'Saved';
  if (source === 'custom_food') return 'Custom';
  return 'Meal';
}

function parseSavedFoodCollection(value: Record<string, unknown> | null, source: SavedFoodSource): SavedFoodSearchItem[] {
  return Object.entries(value ?? {})
    .map(([key, raw]) => parseSavedFoodItem(key, asRecord(raw), source))
    .filter((food): food is SavedFoodSearchItem => food != null);
}

function parseSavedFoodItem(id: string, raw: Record<string, unknown> | null, source: SavedFoodSource): SavedFoodSearchItem | null {
  if (!raw) {
    return null;
  }
  if (source === 'my_meal') {
    const total = asRecord(raw.total);
    const name = parseString(raw.title);
    if (!name) {
      return null;
    }
    return {
      source,
      id: parseString(raw.id) ?? id,
      name,
      servingDescription: '1 serving',
      servingQuantity: 1,
      servingUnit: 'serving',
      calories: parseNumberLike(total?.energy) ?? 0,
      protein: parseNumberLike(total?.protein) ?? 0,
      carbohydrate: parseNumberLike(total?.net_carbs) ?? 0,
      fat: parseNumberLike(total?.fat) ?? 0,
      timestamp: parseNumberLike(raw.timestamp) ?? 0,
      raw,
    };
  }

  const name = parseString(raw.food_name);
  if (!name) {
    return null;
  }
  const servingQuantity = parseNumberLike(raw.serving_qtd) ?? parseNumberLike(raw.serving_size) ?? 1;
  const servingUnit = parseString(raw.serving_unit) ?? 'serving';
  return {
    source,
    id: parseString(raw.id) ?? id,
    foodId: parseString(raw.food_id) ?? undefined,
    customFoodId: parseString(raw.food_customized_id) ?? (source === 'custom_food' ? parseString(raw.id) ?? id : undefined),
    name,
    brandName: parseString(raw.brand_name) ?? undefined,
    servingDescription: parseString(raw.serving_description) ?? `${formatNumber(servingQuantity)} ${servingUnit}`,
    servingQuantity,
    servingUnit,
    calories: parseNumberLike(raw.calories) ?? 0,
    protein: parseNumberLike(raw.protein) ?? 0,
    carbohydrate: parseNumberLike(raw.carbohydrate) ?? parseNumberLike(raw.net_carbs) ?? 0,
    fat: parseNumberLike(raw.fat) ?? 0,
    timestamp: parseNumberLike(raw.timestamp) ?? 0,
    raw,
  };
}

function scoreSavedFoodMatch(food: SavedFoodSearchItem, query: string): number {
  const normalizedQuery = normalizeFoodCacheKey(query);
  const searchable = normalizeFoodCacheKey([food.name, food.brandName, savedFoodSourceLabel(food.source)].filter(Boolean).join(' '));
  if (!normalizedQuery || !searchable) {
    return 0;
  }
  if (searchable === normalizedQuery) {
    return 100;
  }
  if (searchable.includes(normalizedQuery)) {
    return 80;
  }
  const queryTokens = normalizedQuery.split(' ').filter(token => token.length > 2);
  if (queryTokens.length === 0) {
    return 0;
  }
  const overlap = queryTokens.filter(token => searchable.includes(token)).length;
  return overlap === 0 ? 0 : (overlap / queryTokens.length) * 60;
}

function dedupeSavedFoods(foods: SavedFoodSearchItem[]): SavedFoodSearchItem[] {
  const seen = new Set<string>();
  const deduped: SavedFoodSearchItem[] = [];
  for (const food of foods) {
    const key = savedFoodDedupeKey(food);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(food);
  }
  return deduped;
}

function savedFoodDedupeKey(food: SavedFoodSearchItem): string {
  if (food.customFoodId) {
    return `custom:${food.customFoodId}`;
  }
  if (food.foodId) {
    return `fatsecret:${food.foodId}`;
  }
  return `${food.source}:${food.id}`;
}

function savedFoodSourceRank(source: SavedFoodSource): number {
  return source === 'favorite' ? 0 : source === 'custom_food' ? 1 : 2;
}

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
