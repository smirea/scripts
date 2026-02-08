# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create symlinks in `~/bin`:

```sh
bun src/setup.ts
```

## Scripts

- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit. Supports `--who` for reading/writing `AI_COMITTER_NAME` in `.env` files.
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd` (aliases: `ls`, `rm`, `del`). `rm/del` can remove the current worktree when called without a branch, except on `master`. Worktrees live under `~/worktrees/<repo>__<branch>`; `add` copies `.env*` files and runs `bun install`.
- `macrofactor` (`src/macrofactor.ts`): export recent foods plus nutrition from MacroFactor's local `historyFood.json` cache (defaults to the last 7 days). Supports `--format=json|table|csv` (default `table`) and `--app/--no-app` (default `--app`) to refresh from the app when local sync is older than 1 hour.
- `whoop-pull` (`src/whoop-pull.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI).
- `setup` (`src/setup.ts`): creates/refreshes symlinks for the scripts in `~/bin`.
