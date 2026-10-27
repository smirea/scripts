import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

export function gitEnvironment() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnvironment() });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git inspection failed.');
  return result.stdout.trim();
}

export function runningT3Worktree(root: string, database = join(homedir(), '.t3/userdata/statev2.sqlite')) {
  if (!existsSync(database)) return false;
  const db = new Database(database, { readonly: true });
  try {
    return db.query(`
      SELECT 1 FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE json_extract(t.payload_json, '$.worktreePath') = ?
        AND r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'rolled_back')
      LIMIT 1
    `).get(root) !== null;
  } finally {
    db.close();
  }
}

export function openFiles() {
  const result = spawnSync('lsof', ['-nP', '-F', 'n'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot inspect open files; leaving build caches alone.');
  return result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
}

export function cleanWorktreeCache(directory: string, options: {
  dryRun?: boolean;
  isRunning?: (root: string) => boolean;
  openPaths?: () => string[];
} = {}) {
  const root = realpathSync(directory);
  if (git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('Pass the worktree root.');
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
  const commonDir = resolve(root, git(root, 'rev-parse', '--git-common-dir'));
  if (realpathSync(gitDir) === realpathSync(commonDir)) return ['Kept: main checkout.'];
  if ((options.isRunning ?? runningT3Worktree)(root)) return ['Kept: a T3 run still uses this worktree.'];

  const paths = ['DerivedData', 'app-ios/DerivedData'].filter(name => existsSync(join(root, name)));
  if (!paths.length) return ['No worktree build caches.'];
  const opened = (options.openPaths ?? openFiles)();
  const messages: string[] = [];
  for (const name of paths) {
    const cache = join(root, name);
    // Only the known, wholly ignored build directory is disposable; never follow a link out of it.
    if (!lstatSync(cache).isDirectory() || realpathSync(cache) !== cache || relative(root, cache).startsWith(`..${sep}`)) {
      messages.push(`Kept ${name}: not a local build directory.`);
      continue;
    }
    const ignored = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', `${name}/`], { env: gitEnvironment() });
    if (ignored.status !== 0 || git(root, 'ls-files', '--', name)) {
      messages.push(`Kept ${name}: contains tracked files or is not ignored.`);
      continue;
    }
    if (opened.some(path => path === cache || path.startsWith(`${cache}${sep}`))) {
      messages.push(`Kept ${name}: still open in another process.`);
      continue;
    }
    if ((options.isRunning ?? runningT3Worktree)(root)) {
      messages.push(`Kept ${name}: a T3 run started.`);
      continue;
    }
    if (!options.dryRun) rmSync(cache, { recursive: true });
    messages.push(`${options.dryRun ? 'Would remove' : 'Removed'} ${cache}`);
  }
  return messages;
}
