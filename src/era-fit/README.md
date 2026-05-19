# Era Fit CLI

Local Bun CLI for reading and writing Era Fit nutrition data.

## Commands

- `era-fit print-food` prints logged foods and macro totals.
- `era-fit mealplan` prints the suggested weekly meal plan and shopping list.
- `era-fit mealplan --anylist` creates/replaces an AnyList shopping list for the current meal plan.
- `era-fit mealplan -t` opens the interactive checklist for today's meal plan.
- `era-fit mealplan -t --dry-run` runs the interactive checklist without writing to Era Fit or updating `cache.json`.
- `era-fit track [meal] <items>` logs ad hoc foods. Separate multiple foods with commas, for example `era-fit track s1 1 banana, 2scoop protein powder`.

`era-fit meaplan` is kept as a typo alias for `mealplan`.

## Interactive Meal Plan

`era-fit mealplan -t` fetches today's suggested meal plan, fetches foods already tracked for today, and renders a terminal checklist grouped by meal.

The mode is meant to be fast:

- Use the meal-plan rows when you are following the plan.
- Use replacement search when the suggested item is close but not what you actually ate.
- Use assign when you already logged something manually and want future runs to understand that it covers a planned item.

## Symbols

- `○` means unchecked.
- `⊝` means a meal is partially checked.
- `×` means a meal-plan item is checked or already matched to an Era Fit log.
- `✔` means a green item was logged in Era Fit but is outside the meal plan.
- `↣` marks the assign target while assigning an outside-plan item.
- `◐`, `◓`, `◑`, `◒` are loading states while a log/unlog/search request is pending.
- `tracked` next to a checked item means the item was already present in Era Fit when the screen loaded or after cache rematching.

Checked meal-plan rows are crossed out. Outside-plan rows stay green so they are visually distinct from planned items.

## Navigation

Meal mode:

- `↑` / `↓` moves between meals.
- `→` enters the selected meal and selects the first unchecked item, or the first item if everything is checked.
- `␣` toggles the entire meal.
- `Esc` or `q` exits.

Item mode:

- `↑` / `↓` moves between items in the selected meal.
- `←` or `Esc` returns to meal mode.
- `␣` toggles the selected meal-plan item.
- `R` sets a serving multiplier for the selected meal-plan item.
- `S` opens alternative search for the selected meal-plan item.
- `A` starts assign mode when the selected row is a green outside-plan item.
- `q` exits.

Search mode:

- Search opens with the planned item name already filled in.
- Results render below the meal-plan table; the table stays visible.
- Typing updates the query and reloads results after a short debounce.
- `↑` / `↓` moves through search results.
- `Enter` logs the selected result for the planned item.
- `Esc` returns to item mode.
- `Ctrl-C` exits.

Assign mode:

- `A` on a green outside-plan item starts assign mode.
- The cursor jumps to the first unchecked meal-plan item in the same meal when possible.
- `↑` / `↓` moves only between unchecked meal-plan targets.
- `␣` or `A` assigns the outside-plan item to the selected target.
- `←` or `Esc` cancels assign mode and returns to the outside-plan item.
- `q` exits.

Assign does not exit the interactive checklist. It writes an alias to the cache, reruns cache-based matching, removes the outside-plan row when it is now covered, and re-renders out of assign mode so you can keep checking items.

## Matching Existing Logs

At startup, and after assignments, the checklist tries to match current Era Fit logs to the meal plan in this order:

1. Cache aliases in `src/era-fit/cache.json`.
2. Rough text match on planned item name/description and tracked food name.
3. Macro proximity when text matching fails: calories, protein, net carbs, and fat must all be within 5%.

Matched logs are consumed once so one tracked food does not satisfy multiple planned rows. Anything left unmatched appears as a green outside-plan item under its Era Fit meal.

## Cache Behavior

`src/era-fit/cache.json` stores:

- `mealPlanMealMap`: maps meal-plan meal keys to Era Fit tracking meal keys.
- `foods`: aliases from meal-plan item labels to a concrete Era Fit food, saved food, custom food, my meal, serving, and optional serving multiplier.

The cache is used by both `track` and interactive `mealplan -t`.

Normal check-off flow:

- If a planned item has a cache entry, the cached food/serving is used directly.
- If there is no cache hit, checking an item opens search so you can choose the correct Era Fit food.
- Successful selections write all useful aliases for the planned item back to `cache.json`.

Assignment flow:

- Assigning an outside-plan logged item to a planned item writes that logged food as the planned item's cache alias.
- The serving multiplier is inferred as `tracked serving quantity / planned item amount`.
- Example: assigning `Boba Tea Protein (2 servings)` to `2 scoops Whey Protein` stores multiplier `1`, so future `1 scoop Whey Protein` maps to `1 serving` of that cached food.
- In `--dry-run`, assignments update the cache in memory only so the screen can prove the behavior without changing files.

## Logging and Unchecking

Checking a planned item logs it to Era Fit for today's date and that meal.

Checking a meal logs every unchecked planned item in that meal. While the request is pending, the row or meal shows a spinner and navigation remains usable.

Unchecking a checked item deletes the matching Era Fit tracked food when the item is backed by a known tracked record. Session-only dry-run checks are simply removed from the local checklist state.

## Alternatives and Serving Multipliers

`S` is for choosing a different food than the plan text. It searches saved/custom foods and standard Era Fit food results; saved matches are shown at the top and marked with `★` when available.

`R` sets a multiplier before logging or searching. Use it for cases like half a planned serving or a larger portion. The multiplier affects the amount sent to search/logging and is shown next to the item label until changed back to `1`.

## Dry Run

Use `era-fit mealplan -t --dry-run` when testing interactions.

Dry run still fetches the meal plan, current tracked foods, search results, and cache matches. It does not write tracked foods, delete tracked foods, or persist cache updates.
