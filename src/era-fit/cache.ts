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
  servingMultiplier: z.number().positive().optional(),
  updatedAt: z.string(),
});

const CachedFoodReplacementSchema = z.object({
  selection: CachedFoodSelectionSchema,
  label: z.string(),
  servingDescription: z.string(),
  calories: z.number().nullable(),
  protein: z.number().nullable(),
  netCarbs: z.number().nullable(),
  fat: z.number().nullable(),
  updatedAt: z.string(),
});

const EraFitCacheSchema = z.object({
  version: z.literal(1),
  foods: z.record(z.string(), CachedFoodSelectionSchema),
  replacements: z.record(z.string(), z.array(CachedFoodReplacementSchema)).default({}),
  mealPlanMealMap: z.record(z.string(), EraFitMealKeySchema).default(DEFAULT_MEAL_PLAN_MEAL_MAP),
});

export type CachedFoodSelection = z.infer<typeof CachedFoodSelectionSchema>;
export type CachedFoodReplacement = z.infer<typeof CachedFoodReplacementSchema>;
export type CachedFoodReplacementInput =
  Omit<CachedFoodReplacement, 'selection' | 'updatedAt'> & {
    selection: Omit<CachedFoodSelection, 'updatedAt'>;
  };
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

export function getFoodReplacements(cache: EraFitCache, aliases: string[]): CachedFoodReplacement[] {
  const seen = new Set<string>();
  return aliases
    .flatMap(alias => cache.replacements[normalizeFoodCacheKey(alias)] ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter(replacement => {
      const key = replacementDedupeKey(replacement);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function rememberFoodReplacement(
  cache: EraFitCache,
  aliases: string[],
  replacement: CachedFoodReplacementInput
): void {
  rememberFoodReplacementInCache(cache, aliases, replacement);
  saveEraFitCache(cache);
}

export function rememberFoodReplacementInCache(
  cache: EraFitCache,
  aliases: string[],
  replacement: CachedFoodReplacementInput
): void {
  const timestamp = new Date().toISOString();
  for (const alias of aliases) {
    const aliasKey = normalizeFoodCacheKey(alias);
    if (!aliasKey) {
      continue;
    }
    const next = {
      ...replacement,
      updatedAt: timestamp,
      selection: {
        ...replacement.selection,
        updatedAt: timestamp,
      },
    };
    const replacementKey = replacementDedupeKey(next);
    const existing = cache.replacements[aliasKey] ?? [];
    cache.replacements[aliasKey] = [
      next,
      ...existing.filter(entry => replacementDedupeKey(entry) !== replacementKey),
    ].slice(0, 10);
  }
}

function replacementDedupeKey(replacement: Pick<CachedFoodReplacement, 'selection' | 'label'>): string {
  const selection = replacement.selection;
  return normalizeFoodCacheKey([
    selection.savedSource,
    selection.customFoodId,
    selection.savedId,
    selection.foodId,
    selection.foodName,
    selection.brandName,
    replacement.label,
  ].filter(value => value != null && String(value).trim()).join('|'));
}
