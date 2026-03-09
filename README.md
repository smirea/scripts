# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create symlinks in `~/bin`:

```sh
bun src/setup.ts
```

## Scripts

- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit with explicit AI author/committer identity via vanilla `git commit`. Supports `--who` for reading the effective identity and setting `AI_COMITTER_NAME` via `env-manager global set`. Also available as `git ai-cim` after running setup (via `git-ai-cim` symlink).
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd`, `merge` (aliases: `ls`, `rm`). `merge` can select a worktree branch interactively and merge it into the current branch, then optionally remove the merged branch/worktree (default yes). Worktrees live under `~/worktrees/<repo>__<branch>`; `add` runs `bun install`.
- `macrofactor` (`src/macrofactor.ts`): export recent foods plus nutrition from MacroFactor's local `historyFood.json` cache (defaults to the last 7 days). Supports `--format=json|table|csv` (default `table`) and `--app/--no-app` (default `--app`) to refresh from the app when local sync is older than 1 hour.
- `macrofactor-new` (`src/macrofactor-new.ts`): export recent foods plus nutrition from MacroFactor's Firebase/Firestore API using `MACROFACTOR_CREDENTIALS=<email>:<password>`. Keeps the grouped recent-food output and supports `--days`, `--start`, `--end`, `--limit`, `--format=json|table|csv`, `--output`, and `--pretty`.
- `voice-memo-parse` (`src/voice-memo-parse.ts`): opens Voice Memos, waits for sync, exports new recordings from a folder (default `Captain's Log`) into `~/Documents/voice-memos/captains-log` as audio + markdown pairs using `YYYY-MM-DD_HH-MM` naming, uses embedded transcripts with Gemini fallback when needed, and regenerates `_overview.md` with Gemini-powered highlights for each memo (`# [date] [location] ([audio]/[md])`). Highlights default to Gemini 3 Flash and automatically fall back to `gemini-2.5-flash` if unavailable. Supports `--setup-permissions` to check permission status, open relevant System Settings pages, and print exact manual steps for anything macOS cannot auto-prompt.
- `whoop-pull` (`src/whoop-pull.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI). If `WHOOP_REFRESH_TOKEN` is missing, it opens the WHOOP auth URL in your default browser, supports manual `--auth-code` exchange, and can persist `--token` / rotated refresh tokens into `.env.local`.
- `setup` (`src/setup.ts`): creates/refreshes symlinks for the scripts in `~/bin`.
