# scripts

Small personal CLI helpers.

## Setup

Run the setup script to create command wrappers in `~/bin`:

```sh
bun src/setup.ts
```

Each wrapper calls `src/run.ts`, which loads this repo's `.env` and `.env.local` before forwarding args, stdin, stdout, stderr, and the caller's current working directory to the real script.

## Scripts

- `airbnb` (`airbnb.ts`): read reservations and wishlists as Markdown. Pass a confirmation code or wishlist ID for details; use `--refresh-session` to save credentials from signed-in Chrome via Browser Gate.
- `gai` (`src/git-commit-ai.ts`): generate a conventional commit message from staged changes using Gemini, then commit as the current git user while appending a `Co-Authored-By` trailer for the configured AI identity. Supports `--who` for reading the effective trailer identity and setting `AI_COMITTER_NAME` via `env-manager global set`. Also available as `git ai-cim` after running setup (via the `git-ai-cim` wrapper).
- `git-invite-ai-to-repos` (`src/git-invite-ai-to-repos.ts`): invite the configured AI GitHub account to owner repositories created in the past year, or specific repositories via `--repos`, then accept those invitations and set every repository the AI account collaborates on to ignore all notifications, using GitHub CLI's stored multi-account auth.
- `git-worktree` / `wt` (`src/git-worktree.ts`): manage git worktrees with `add`, `list`, `remove`, `cd`, `merge` (aliases: `ls`, `rm`). `rm` always uses `git worktree remove --force`. `merge` can select a worktree branch interactively and merge it into the current branch, then optionally remove the merged branch/worktree (default yes). Worktrees live under `~/worktrees/<repo>__<branch>`; `add` runs `bun install`.
- `iphone-deploy` (`src/iphone-deploy.ts`): build Release apps and install them on a paired iPhone with `push <apps..>`, or upload an install link with `link <apps..>`. Runs `bun run env:ios` before building when the app directory or repository root defines it, after generating the selected env-manager environment. Generated env-manager values are restored even if preparation or building fails.
- `convex-manage` (`src/convex-manage.ts`): manage local self-hosted Convex deployments. `convex-manage create -n <name>` creates an isolated Docker Compose deployment under `~/code/convex-deployments/<name>` by default, prints the app env vars, and registers macOS boot start unless `--no-boot` is passed. `convex-manage restart <id>`, `convex-manage dashboard <id>`, and `convex-manage delete <id>` accept either a standard deployment folder name or a full deployment path.
- `email-inbox` (`src/email-inbox.ts`): with no command, show each inbox's total emails and latest email date/time followed by help. List saved emails, read parsed text or HTML bodies (`read` without an id reads the latest email), and print or save the original `.eml` files from the email-save Worker. All commands accept `-i`/`--inbox email-save|spam`; the flag overrides `EMAIL_INBOX`, which defaults to `email-save` when unset.
- `google-maps` (`src/google-maps.ts`): run Google Places text search and details lookups as JSON. Requires `GOOGLE_MAPS_API_KEY`. Examples: `google-maps search "beginner surf lessons Ericeira Portugal"` and `google-maps details "school name" --near "Ericeira Portugal" --type school --reviews`.
- `macrofactor` (`src/macrofactor.ts`): export MacroFactor nutrition from the local macOS app Firestore cache. By default `--app auto` opens MacroFactor when the cache is stale or requested Food Log documents are missing, warms the requested dates, then quits the app if the script started it. Use `--app open` to force refresh or `--app none` to read only the existing cache. Cache refresh requires macOS Accessibility access. Supports `--days`, `--start`, `--end`, `--limit`, `--format=json|table|csv|csv:full`, `--output`, `--pretty`, and `--full` (`--full` expands detailed-food nutrient columns). `--start 2026-05-01 --days 30` selects May 1–30; without `--start`, `--days` counts backward from `--end` or now. An explicit start and end override `--days`.
- `voice-memo-parse` (`src/voice-memo-parse.ts`): opens Voice Memos, waits for sync, exports new recordings from a folder (default `Captain's Log`) into `~/Documents/voice-memos/captains-log` as audio + markdown pairs using `YYYY-MM-DD_HH-MM` naming, uses embedded transcripts with Gemini fallback when needed, and regenerates `_overview.md` with Gemini-powered highlights for each memo (`# [date] [location] ([audio]/[md])`). Highlights default to Gemini 3 Flash and automatically fall back to `gemini-2.5-flash` if unavailable. Supports `--setup-permissions` to check permission status, open relevant System Settings pages, and print exact manual steps for anything macOS cannot auto-prompt.
- `whoop-pull` (`src/whoop.ts`): fetch WHOOP data as JSON (defaults to the last 2 days; configurable via CLI). If `WHOOP_REFRESH_TOKEN` is missing, it opens the WHOOP auth URL in your default browser, supports manual `--auth-code` exchange, and can persist `--token` / rotated refresh tokens into `.env.local`.
- `setup` (`src/setup.ts`): creates/refreshes wrappers for the scripts in `~/bin`.

### Google Maps location

`google-maps` uses `--near` when provided. Otherwise, on macOS it tries
CoreLocationCLI, then falls back to an approximate public-IP location.
Install the device location helper with `brew install --cask corelocationcli`
and run `CoreLocationCLI` once to approve macOS location access. Keep Wi-Fi
enabled for device location. If macOS blocks the helper, allow it in System
Settings → Privacy & Security. On permission failures, the script prints instructions and opens the Location
Services settings pane. Device lookup times out after 12 seconds;
if both location sources fail, searches continue without an explicit bias.

## Agent worktrees and simulators

T3 Code creates agent worktrees, names their branches, and runs two global scripts (`defaultProjectScripts` in `~/.t3/userdata/settings.json`): `"$HOME/bin/agent-t3-worktree" setup` on create and `"$HOME/bin/agent-t3-worktree" settle` on settle. `sidebarAutoSettleOnMerge` makes a merged PR settle its thread. Nothing runs on a schedule.

- `agent-t3-worktree setup` runs `bun install --frozen-lockfile`, gives the worktree its own 10-port block (every `*PORT` default in the root `.env` and each localhost `*_URL` on one of them, at main + 10000 + (n - 1) * 1000), writes it to `.env.override` (env-manager targets) or `.env.local` (single-project or no env-manager), runs `env-manager gen --local`, then the repo's `worktree:setup` package script. It records what it created in the worktree's git dir.
- `agent-t3-worktree check [--heal]` fails when that record is missing or a created file, `node_modules`, or the lockfile changed; `--heal` reruns setup. A global Claude Code `SessionStart` hook and each repo's pre-commit run it. A hand-made worktree that setup never ran in passes.
- `agent-t3-worktree settle` stops the worktree's servers and simulators, removes ignored `DerivedData` and `.build` caches when no T3 run or open file uses them, and runs `gc` on its repository.
- `agent-t3-worktree gc [--repo <path>] [--dry-run] [--include-open-threads]` covers T3's projects only, and removes only agent worktrees (under `~/.t3/worktrees` or `.claude/worktrees`). One goes when a PR merged into the default branch holds every commit of its HEAD and it is clean (a failing `git status` counts as dirty), no process works in it, and no T3 thread on it is running or still open (unsettled); `--include-open-threads` drops that last rule for a manual sweep. Its servers (the port block setup assigned), simulators, and branch (local and origin) go with it. gc also deletes merged branches no worktree uses and empty leftover T3 directories, then runs `agent-simulator gc`. Everything else is listed, never touched; if `lsof` lists nothing, it stops.
- `agent-t3-worktree teardown <path|branch> [--force [--delete-branch]]` removes one worktree that way and updates the default branch. `--force` skips the merged check but keeps the branch unless `--delete-branch`.
- `agent-simulator udid [n]` creates and claims the worktree's simulator (named after its directory, the newest iPhone Pro on the newest iOS runtime); `wait [udid]` holds a boot while CPU is above 70% or 4 simulators are booted (`AGENT_SIMULATOR_MAX_BOOTED`), exiting 3 after 3 minutes; `stop`, `remove <worktree>`, `gc`, and `status` do the rest. A claim decides ownership; a name match counts only for unclaimed simulators, and a name another live worktree holds gets a suffix. `gc` deletes a simulator only when it was made for a worktree that is gone and it is shut down and unused; a stock simulator a removed worktree claimed only loses the claim. Idle shutdown skips simulators agent-device drove in the last 15 minutes. Driving the simulator is T3's `device_open`.
