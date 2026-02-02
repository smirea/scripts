# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create symlinks in `~/bin`:

```sh
bun src/setup.ts
```

## Scripts

- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit. Supports `--who` for reading/writing `AI_COMITTER_NAME` in `.env` files.
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd` (aliases: `ls`, `rm`). Worktrees live under `~/worktrees/<repo>__<branch>`; `add` copies `.env*` files and runs `bun install`.
- `whoop-pull` (`src/whoop-pull.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI).
- `setup` (`src/setup.ts`): creates/refreshes symlinks for the scripts in `~/bin`.
