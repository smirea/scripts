# AGENTS

- Run `src/setup.ts` to (re)create symlinks for scripts. Add new scripts here as needed
- when making a new script try using `src/utils/createScript.ts`
- use `yargs` for arg management, always use `.help()` and `.strict()` arg parsing and proper reasonable arg types, remove the --version and allow the text to wrap to the terminal dimensions. write descriptions for each argument where not obvious
- if interactivity is desired see how other scripts in this repo do it and use the same libs
- read project environment variables directly from `src/env.ts` (default `env` object) only; do not add other env parsing/loading utilities. keep system vars (like `HOME`/`SHELL`) on `process.env`. when env keys change, run `env-manager ts` to regenerate `src/env.ts`
