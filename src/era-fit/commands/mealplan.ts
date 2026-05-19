import type { CommandModule } from 'yargs';

import { addMealPlanOptions, type MealPlanCliArgs, runMealPlanCommand } from '../core';

export const mealPlanCommand = {
  command: ['mealplan', 'meaplan'],
  describe: 'Print the weekly suggested meal plan and aggregate shopping list',
  builder: addMealPlanOptions,
  handler: runMealPlanCommand,
} satisfies CommandModule<{}, MealPlanCliArgs>;
