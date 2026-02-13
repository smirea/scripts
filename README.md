# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create symlinks in `~/bin`:

```sh
bun src/setup.ts
```

## Scripts

- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit with explicit AI author/committer identity via vanilla `git commit`. Supports `--who` for reading/writing `AI_COMITTER_NAME` in `.env` files and allows overriding the AI email with `AI_COMITTER_EMAIL`/`AI_COMMITTER_EMAIL`. Also available as `git ai-cim` after running setup (via `git-ai-cim` symlink).
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd`, `merge` (aliases: `ls`, `rm`). `merge` can select a worktree branch interactively and merge it into the current branch, then optionally remove the merged branch/worktree (default yes). Worktrees live under `~/worktrees/<repo>__<branch>`; `add` copies `.env*` files and runs `bun install`.
- `macrofactor` (`src/macrofactor.ts`): export recent foods plus nutrition from MacroFactor's local `historyFood.json` cache (defaults to the last 7 days). Supports `--format=json|table|csv` (default `table`) and `--app/--no-app` (default `--app`) to refresh from the app when local sync is older than 1 hour.
- `whoop-pull` (`src/whoop-pull.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI).
- `setup` (`src/setup.ts`): creates/refreshes symlinks for the scripts in `~/bin`.
