import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const CACHE_PATH = path.join(import.meta.dir, 'cache.json');
const EraFitMealKeySchema = z.enum(['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner', 'snack_evening']);

export const DEFAULT_MEAL_PLAN_MEAL_MAP = {
  breakfast: 'breakfast',
  morning_snack: 'snack_am',
  lunch: 'lunch',
  afternoon_snack: 'snack_pm',
  dinner: 'dinner',
  evening_snack: 'snack_evening',
} as const;

const CachedFoodSelectionSchema = z.object({
  foodId: z.string(),
  foodName: z.string(),
  brandName: z.string().optional(),
  servingType: z.enum(['fatsecret', 'standard', 'saved']),
  servingId: z.string().optional(),
  servingUnit: z.string().optional(),
  servingDescription: z.string(),
  savedSource: z.enum(['favorite', 'custom_food', 'my_meal']).optional(),
  savedId: z.string().optional(),
  customFoodId: z.string().optional(),
  servingQuantity: z.number().optional(),
  updatedAt: z.string(),
});

const EraFitCacheSchema = z.object({
  version: z.literal(1),
  foods: z.record(z.string(), CachedFoodSelectionSchema),
  mealPlanMealMap: z.record(z.string(), EraFitMealKeySchema).default(DEFAULT_MEAL_PLAN_MEAL_MAP),
});

export type CachedFoodSelection = z.infer<typeof CachedFoodSelectionSchema>;
export type EraFitCache = z.infer<typeof EraFitCacheSchema>;

export function normalizeFoodCacheKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function loadEraFitCache(): EraFitCache {
  return EraFitCacheSchema.parse(JSON.parse(readFileSync(CACHE_PATH, 'utf8')));
}

export function saveEraFitCache(cache: EraFitCache): void {
  writeFileSync(CACHE_PATH, `${JSON.stringify(EraFitCacheSchema.parse(cache), null, 2)}\n`, 'utf8');
}

export function rememberFoodSelection(cache: EraFitCache, alias: string, selection: Omit<CachedFoodSelection, 'updatedAt'>): void {
  const key = normalizeFoodCacheKey(alias);
  if (!key) {
    return;
  }
  cache.foods[key] = {
    ...selection,
    updatedAt: new Date().toISOString(),
  };
  saveEraFitCache(cache);
}
