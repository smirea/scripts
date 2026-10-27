import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanWorktreeCache, gitEnvironment, runningT3Worktree } from './worktreeCache';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-cache-test-')));
  temporary.push(dir);
  const main = join(dir, 'main');
  mkdirSync(main);
  function git(cwd: string, ...args: string[]) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnvironment() });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  git(main, 'init', '-q');
  writeFileSync(join(main, '.gitignore'), 'app-ios/DerivedData/\nDerivedData/\n');
  writeFileSync(join(main, 'source.txt'), 'source');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const worktree = join(dir, 'worktree');
  git(main, 'worktree', 'add', '-qb', 'feature', worktree);
  const cache = join(worktree, 'app-ios/DerivedData');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'build.dat'), 'rebuildable');
  return { dir, main, worktree, cache, git };
}

const idle = { isRunning: () => false, openPaths: () => [] };

test('cleans ignored output on a detached worktree without touching source, env or database files', () => {
  const { worktree, cache, git } = fixture();
  git(worktree, 'checkout', '--detach', '-q');
  writeFileSync(join(worktree, 'source.txt'), 'uncommitted source');
  writeFileSync(join(worktree, '.env.local'), 'private');
  writeFileSync(join(worktree, 'app.sqlite'), 'user data');
  cleanWorktreeCache(worktree, idle);
  expect(existsSync(cache)).toBe(false);
  for (const file of ['source.txt', '.env.local', 'app.sqlite', '.git']) expect(existsSync(join(worktree, file))).toBe(true);
});

test('dry run and main checkout protection preserve output', () => {
  const { main, worktree, cache } = fixture();
  cleanWorktreeCache(worktree, { ...idle, dryRun: true });
  expect(existsSync(cache)).toBe(true);
  mkdirSync(join(main, 'DerivedData'));
  cleanWorktreeCache(main, idle);
  expect(existsSync(join(main, 'DerivedData'))).toBe(true);
});

test('tracked files, symlinks, active runs and open build files block deletion', () => {
  const { dir, worktree, cache, git } = fixture();
  expect(cleanWorktreeCache(worktree, { ...idle, isRunning: () => true })[0]).toContain('still uses');
  cleanWorktreeCache(worktree, { ...idle, openPaths: () => [join(cache, 'build.dat')] });
  expect(existsSync(cache)).toBe(true);
  git(worktree, 'add', '-f', 'app-ios/DerivedData/build.dat');
  cleanWorktreeCache(worktree, idle);
  expect(existsSync(cache)).toBe(true);
  git(worktree, 'reset', '-q');
  rmSync(cache, { recursive: true });
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'important');
  symlinkSync(outside, cache);
  cleanWorktreeCache(worktree, idle);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  expect(existsSync(cache)).toBe(true);
});

test('a running child in the same T3 worktree blocks cleanup after its parent finishes', () => {
  const { dir, worktree } = fixture();
  const file = join(dir, 'state.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)');
  for (const [id, status] of [['parent', 'completed'], ['child', 'running']]) {
    db.query('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run(id!, JSON.stringify({ worktreePath: worktree }));
    db.query('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)').run(id!, status!);
  }
  expect(runningT3Worktree(worktree, file)).toBe(true);
  db.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed'");
  expect(runningT3Worktree(worktree, file)).toBe(false);
  db.close();
});

test('inspection failures leave build output untouched', () => {
  const { dir, worktree, cache } = fixture();
  expect(() => cleanWorktreeCache(worktree, { ...idle, openPaths: () => { throw new Error('lsof unavailable'); } })).toThrow('lsof unavailable');
  const database = join(dir, 'broken.sqlite');
  writeFileSync(database, 'not a database');
  expect(() => cleanWorktreeCache(worktree, { ...idle, isRunning: root => runningT3Worktree(root, database) })).toThrow();
  expect(existsSync(cache)).toBe(true);
});
