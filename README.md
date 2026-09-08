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
- `convex-manage` (`src/convex-manage.ts`): manage local self-hosted Convex deployments. `convex-manage create -n <name>` creates an isolated Docker Compose deployment under `~/code/convex-deployments/<name>` by default, prints the app env vars, and registers macOS boot start unless `--no-boot` is passed. `convex-manage restart <id>`, `convex-manage dashboard <id>`, and `convex-manage delete <id>` accept either a standard deployment folder name or a full deployment path.
- `email-inbox` (`src/email-inbox.ts`): list saved emails, read parsed text or HTML bodies, and print or save the original `.eml` files from the email-save Worker.
- `google-maps` (`src/google-maps.ts`): run Google Places text search and details lookups as JSON. Requires `GOOGLE_MAPS_API_KEY`. Examples: `google-maps search "beginner surf lessons Ericeira Portugal"` and `google-maps details "school name" --near "Ericeira Portugal" --type school --reviews`.
- `macrofactor` (`src/macrofactor.ts`): export MacroFactor nutrition from the local macOS app Firestore cache. By default `--app=auto` opens MacroFactor when the app-backed cache is older than 12 hours or the requested Food Log documents are missing, warms the Food Log UI for the requested dates, then quits the app if the script started it. Use `--app=open` to force the warm step or `--app=none` to read only the existing cache. Supports `--days`, `--start`, `--end`, `--limit`, `--format=json|table|csv|csv:full`, `--output`, `--pretty`, and `--full` (`--full` expands the detailed-food CSV/table nutrient columns, including inside `csv:full`).
- `voice-memo-parse` (`src/voice-memo-parse.ts`): opens Voice Memos, waits for sync, exports new recordings from a folder (default `Captain's Log`) into `~/Documents/voice-memos/captains-log` as audio + markdown pairs using `YYYY-MM-DD_HH-MM` naming, uses embedded transcripts with Gemini fallback when needed, and regenerates `_overview.md` with Gemini-powered highlights for each memo (`# [date] [location] ([audio]/[md])`). Highlights default to Gemini 3 Flash and automatically fall back to `gemini-2.5-flash` if unavailable. Supports `--setup-permissions` to check permission status, open relevant System Settings pages, and print exact manual steps for anything macOS cannot auto-prompt.
- `whoop-pull` (`src/whoop.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI). If `WHOOP_REFRESH_TOKEN` is missing, it opens the WHOOP auth URL in your default browser, supports manual `--auth-code` exchange, and can persist `--token` / rotated refresh tokens into `.env.local`.
- `setup` (`src/setup.ts`): creates/refreshes wrappers for the scripts in `~/bin`.

## Airbnb

`airbnb.ts` reads Airbnb directly through its private API and prints Markdown. Normal runs do not open or activate browser tabs. Run `bun src/setup.ts` to install the `airbnb` command.

```sh
airbnb reservations --refresh-session
airbnb reservations
airbnb reservations <confirmation-code>
airbnb wishlists
airbnb wishlists <wishlist-id>
```

Initial setup and later `--refresh-session` runs use the signed-in Chrome session through `~/code/chrome-browsergate/scripts/invoke`. Working credentials are saved only in the ignored `.env.local`; project variables are read through `src/env.ts`. Sign in on airbnb.com and refresh again if the session expires.

`reservations` shows current/upcoming stays with local check-in/out times, address, host, guest counts, and listing links. Pass a confirmation code to look up a specific stay, including a past reservation. `wishlists` paginates all lists; pass its numeric ID for saved listing details, prices, availability for the saved search, notes, and votes. Redirect stdout to save Markdown. Airbnb's private query hashes may need updating when its API changes.
