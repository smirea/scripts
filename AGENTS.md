# AGENTS

- `gai` points to `src/git-commit-ai.ts` via the symlink at `~/bin/gai`.
- Run `src/setup.ts` to (re)create symlinks; it will grow as more scripts are added.
- Env vars: `AI_COMITTER_NAME` overrides the committer name; `DEFAULT_AI_COMITTER_NAME` is the fallback.
- `gai --who[=name]` writes `AI_COMITTER_NAME` to the nearest `.env` or `.env.local`.
