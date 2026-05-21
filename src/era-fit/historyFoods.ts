import { normalizeFoodCacheKey } from './cache';
import {
  isEraFitMealKey,
  parseNumberLike,
  readEraFitFirebasePath,
  type EraFitMealKey,
  type EraFitSession,
} from './core';
import { trackedFoodRecordMacroTotals, type PastFoodSearchItem, type TrackedFoodRecord } from './tracking';

export async function listPastTrackedFoods(session: EraFitSession): Promise<PastFoodSearchItem[]> {
  const basePath = `db_app/sys_clients/${session.app.id_app}/cl_app_data/cl_progress/meal_tracking_food_data`;
  const data = await readEraFitFirebasePath<Record<string, unknown>>(session, basePath) ?? {};
  return dedupePastFoods(
    Object.entries(data)
      .map(([key, raw]) => parsePastFood(key, asRecord(raw)))
      .filter((food): food is PastFoodSearchItem => food != null)
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
  );
}

export function searchPastTrackedFoods(foods: PastFoodSearchItem[], query: string): PastFoodSearchItem[] {
  const normalizedQuery = normalizeFoodCacheKey(query);
  return foods
    .map(food => ({ food, score: scorePastFoodMatch(food, normalizedQuery) }))
    .filter(entry => !normalizedQuery || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.food.sortKey.localeCompare(a.food.sortKey) || a.food.name.localeCompare(b.food.name))
    .map(entry => entry.food)
    .slice(0, 20);
}

function parsePastFood(key: string, raw: Record<string, unknown> | null): PastFoodSearchItem | null {
  if (!raw) {
    return null;
  }
  const name = parseString(raw.food_name) ?? parseString(raw.title);
  if (!name) {
    return null;
  }
  const keyParts = parseHistoryKey(key);
  const servingQuantity = parseNumberLike(raw.serving_qtd) ?? parseNumberLike(raw.quantity) ?? 1;
  const servingUnit = parseString(raw.serving_unit) ?? 'serving';
  const servingDescription = parseString(raw.serving_description) ?? `${servingQuantity} ${servingUnit}`;
  const record = raw as unknown as TrackedFoodRecord;
  const macros = trackedFoodRecordMacroTotals(record);
  return {
    id: key,
    dateId: keyParts.dateId,
    meal: keyParts.meal,
    name,
    brandName: parseString(raw.brand_name) ?? undefined,
    servingDescription,
    servingQuantity,
    servingUnit,
    calories: macros.calories ?? 0,
    protein: macros.protein ?? 0,
    netCarbs: macros.net_carbs ?? 0,
    fat: macros.fat ?? 0,
    sortKey: key,
    record,
  };
}

function parseHistoryKey(key: string): { dateId: string | null; meal: EraFitMealKey | null } {
  const match = key.match(/^(\d{7})_([a-z_]+)_/);
  if (!match) {
    return { dateId: null, meal: null };
  }
  const meal = isEraFitMealKey(match[2]) ? match[2] : null;
  return { dateId: match[1], meal };
}

function dedupePastFoods(foods: PastFoodSearchItem[]): PastFoodSearchItem[] {
  const seen = new Set<string>();
  const deduped: PastFoodSearchItem[] = [];
  for (const food of foods) {
    const key = pastFoodDedupeKey(food);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(food);
  }
  return deduped;
}

function pastFoodDedupeKey(food: PastFoodSearchItem): string {
  return normalizeFoodCacheKey([
    food.name,
    food.brandName,
  ].filter(value => value != null && String(value).trim()).join('|'));
}

function scorePastFoodMatch(food: PastFoodSearchItem, normalizedQuery: string): number {
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

function parseString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
