# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create command wrappers in `~/bin`:

```sh
bun src/setup.ts
```

Each wrapper calls `src/run.ts`, which loads this repo's `.env` and `.env.local` before forwarding args, stdin, stdout, stderr, and the caller's current working directory to the real script.

## Scripts

- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit as the current git user while appending a `Co-Authored-By` trailer for the configured AI identity. Supports `--who` for reading the effective trailer identity and setting `AI_COMITTER_NAME` via `env-manager global set`. Also available as `git ai-cim` after running setup (via the `git-ai-cim` wrapper).
- `git-invite-ai-to-repos` (`src/git-invite-ai-to-repos.ts`): invite the configured AI GitHub account to owner repositories created in the past year, or specific repositories via `--repos`, then accept those invitations as the AI account using GitHub CLI's stored multi-account auth.
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd`, `merge` (aliases: `ls`, `rm`). `rm` always uses `git worktree remove --force`. `merge` can select a worktree branch interactively and merge it into the current branch, then optionally remove the merged branch/worktree (default yes). Worktrees live under `~/worktrees/<repo>__<branch>`; `add` runs `bun install`.
- `era-fit` (`src/era-fit/index.ts`): exports Era Fit daily nutrition targets and logged foods from the API using a cached `ERA_FIT_SESSION_COOKIE` when it still works, otherwise refreshing it from `ERA_FIT_CREDENTIALS=<email>:<password>`. If the cookie fails and credentials are missing or rejected in an interactive shell, it prompts for them and saves the working value to `.env.local`. The default command and `era-fit print-food` print the daily macro log with `--date`, `--days`, `--start`, `--end`, `--limit`, `--format=json|table|csv|csv:full`, and `--output`. `era-fit mealplan` prints the weekly suggested meal plan with `--today`, `--anylist`, `--format=json|table`, and `--output`.
- `macrofactor` (`src/macrofactor.ts`): export recent foods plus nutrition from MacroFactor's Firebase/Firestore API using `MACROFACTOR_CREDENTIALS=<email>:<password>`. Uses standardized `serving` / `servingGrams` fields across all outputs, includes daily scale weight and body fat when present, and JSON normalizes recipes to the same item shape with `kind` plus `recipeId` when applicable. Supports `--days`, `--start`, `--end`, `--limit`, `--format=json|table|csv|csv:full`, `--output`, `--pretty`, and `--full` (`--full` expands the detailed-food CSV/table nutrient columns, including inside `csv:full`).
- `voice-memo-parse` (`src/voice-memo-parse.ts`): opens Voice Memos, waits for sync, exports new recordings from a folder (default `Captain's Log`) into `~/Documents/voice-memos/captains-log` as audio + markdown pairs using `YYYY-MM-DD_HH-MM` naming, uses embedded transcripts with Gemini fallback when needed, and regenerates `_overview.md` with Gemini-powered highlights for each memo (`# [date] [location] ([audio]/[md])`). Highlights default to Gemini 3 Flash and automatically fall back to `gemini-2.5-flash` if unavailable. Supports `--setup-permissions` to check permission status, open relevant System Settings pages, and print exact manual steps for anything macOS cannot auto-prompt.
- `whoop-pull` (`src/whoop.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI). If `WHOOP_REFRESH_TOKEN` is missing, it opens the WHOOP auth URL in your default browser, supports manual `--auth-code` exchange, and can persist `--token` / rotated refresh tokens into `.env.local`.
- `setup` (`src/setup.ts`): creates/refreshes wrappers for the scripts in `~/bin`.
