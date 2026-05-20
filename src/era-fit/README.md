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

The top summary shows two aligned macro rows:

- `left:` is the remaining daily target after subtracting all matched/logged foods.
- `target:` is the day target from the meal plan.

Each meal title shows remaining macros for that meal: the meal-plan section target minus all foods currently tracked in that meal. Daily and meal remaining values use the same colors: green when within 5% of the target, yellow when still under, and red when over. `C` means net carbs everywhere in this mode.

The mode is meant to be fast:

- Use the meal-plan rows when you are following the plan.
- Use replacement search when the suggested item is close but not what you actually ate.
- Use assign when you already logged something manually and want future runs to understand that it covers a planned item.
- Use add mode when you ate something extra in a meal and want it logged without assigning it to a planned row.

## Symbols

- `○` means unchecked.
- `⊝` means a meal is partially checked.
- `×` means a meal-plan item is checked or already matched to an Era Fit log.
- `✔` means a green item was logged in Era Fit but is outside the meal plan.
- `↣` marks the assign target while assigning an outside-plan item.
- `⊞` means the row has multiple ingredients, such as a saved meal or recipe.
- `⊟` means the ingredient breakdown is expanded.
- `◐`, `◓`, `◑`, `◒` are loading states while a log/unlog/search request is pending.
- `tracked` next to a checked item means the item was already present in Era Fit when the screen loaded or after cache rematching.

Checked meal-plan rows are crossed out when the logged food matches the plan row. Replacement rows show the actual logged food, serving, and macros in green so the replacement stays visible in the meal list. Outside-plan rows stay green so they are visually distinct from planned items.

## Navigation

Meal mode:

- `↑` / `↓` moves between meals.
- `→` enters the selected meal and selects the first unchecked item, or the first item if everything is checked.
- `␣` toggles the entire meal.
- `A` opens add mode for the selected meal.
- `O` temporarily shows the original planned rows for the selected meal when that meal has replacement foods.
- `Esc` or `q` exits.

Item mode:

- `↑` / `↓` moves between items in the selected meal.
- `←` or `Esc` returns to meal mode.
- `␣` toggles the selected meal-plan item.
- `R` sets a serving multiplier for the selected meal-plan item.
- `S` opens alternative search for the selected meal-plan item.
- `E` edits serving and amount for a checked item; on unchecked rows it expands or collapses ingredient components when the row starts with `⊞` or `⊟`.
- `A` starts assign mode when the selected row is a green outside-plan item.
- `q` exits.

Expanded ingredients are reference-only. They render inline under the selected row with their own macros, use already-loaded plan/tracked data, and do not change what gets logged. Pressing `E` again collapses the row; any other action also clears the expansion.

Serving edits reuse the same serving selector and amount prompt used when adding past foods, prefilled from the tracked item. In `--dry-run`, the edited serving is rendered locally without writing to Era Fit.

Original section view is reference-only. It is available when the selected meal has replacement foods; pressing `O` in meal mode swaps the whole meal back to the original meal-plan labels and macros, and the meal title switches from remaining macros to the section target. Press `O` again or take any other action to return to the current logged view.

Search mode:

- Search opens with the planned item name already filled in.
- Results render below the meal-plan table; the table stays visible.
- Typing updates the query and reloads results after a short debounce.
- `↑` / `↓` moves through search results.
- `Enter` selects the highlighted result, then prompts for serving and amount.
- `Esc` returns to item mode.
- `Ctrl-C` exits.

After a replacement is logged, the original planned row stays checked but renders as the actual logged food with its serving and macros. For example, replacing `1 cup Greek Yogurt Plain` with a nonfat yogurt shows the nonfat yogurt row instead of hiding the replacement as an outside-plan item.

Add mode:

- `A` on a meal starts add mode for that meal.
- Results render below the meal-plan table; the table stays visible.
- `←` / `→` switches between `Search`, `Past`, `Faves`, `Meals`, and `Food`.
- `Search` queries global Era Fit foods. `Past` shows recent previously logged foods from Era Fit history. `Faves`, `Meals`, and `Food` show saved favorite foods, saved meals, and custom foods.
- Typing searches or filters the active tab.
- `↑` / `↓` moves through results.
- `Enter` selects the highlighted result, prompts for serving and amount when needed, and adds it to the current meal.
- `Esc` returns to meal mode.
- `Ctrl-C` exits.

Past foods always prompt for serving and amount, prefilled from the previous log. Added foods show as green outside-plan rows under the meal and subtract from that meal title's remaining macros. In `--dry-run`, add mode goes through matching and rendering without writing to Era Fit.

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
- Replacement selections also write aliases for the planned item, so future runs can match the replacement back to the plan row.

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

`S` is for choosing a different food than the plan text. It searches saved/custom foods and standard Era Fit food results; saved matches are shown at the top and marked with `★` when available. After selecting a result, choose the serving and enter the amount. The checked row then displays the actual logged food, serving, and macros.

`R` sets a multiplier before logging or searching. Use it for cases like half a planned serving or a larger portion. The multiplier affects the amount sent to search/logging and is shown next to the item label until changed back to `1`.

## Dry Run

Use `era-fit mealplan -t --dry-run` when testing interactions.

Dry run still fetches the meal plan, current tracked foods, search results, and cache matches. It does not write tracked foods, delete tracked foods, or persist cache updates.
