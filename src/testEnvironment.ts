// Git exports GIT_DIR and GIT_INDEX_FILE to hooks. Tests that drive git in temp repos would otherwise commit, reinit
// and push in this repository when pre-commit runs them. Bun.spawn without an explicit `env` still passes the
// original environment, so spawn git with `env: process.env`.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
