import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, classify, setup, type Entry } from './agentWorktree';
import { gitEnvironment } from './worktreeCache';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnvironment() });
  if (result.status !== 0) throw new Error(result.stderr);
}

function repoWithWorktree(env: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-worktree-test-')));
  temporary.push(dir);
  const main = join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(join(main, '.env'), env);
  writeFileSync(join(main, '.gitignore'), '.env.override\n.env.local\n');
  git(main, 'add', '.');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const worktree = join(dir, 'worktree');
  git(main, 'worktree', 'add', '-qb', 'feature', worktree);
  return { main, worktree };
}

test('without env-manager targets, setup writes each port key and localhost URL into .env.local at the same offset in a free block', async () => {
  const { main, worktree } = repoWithWorktree('UI_URL=http://app.localhost # {url}\nSERVER_URL=http://127.0.0.1:6091/api # {url}\nUI_PORT=6090 # {int}\nPORT=6091 # {int}\n');
  expect(check(worktree)).toEqual(['setup has not run in this worktree']);

  await setup(worktree);
  expect(readFileSync(join(worktree, '.env.local'), 'utf8')).toBe('UI_PORT=16090\nPORT=16091\nSERVER_URL=http://127.0.0.1:16091/api\n');
  expect(check(worktree)).toEqual([]);
  expect(check(main)).toEqual([]);

  unlinkSync(join(worktree, '.env.local'));
  expect(check(worktree)).toEqual(['.env.local is missing']);
  await setup(worktree);
  expect(existsSync(join(worktree, '.env.local'))).toBe(true);
  expect(check(worktree)).toEqual([]);
});

test('with env-manager targets, setup writes the ports to .env.override, keeping other worktrees\' blocks', async () => {
  const { main, worktree } = repoWithWorktree('# env-manager: fixture\n# env-manager target: web format=ts path=.env.local\nCLIENT_PORT=6000 # {int}\nAPI_PORT=6001 # {int}\nAPI_URL=http://127.0.0.1:6001 # {url}\n');
  const other = join(main, '..', 'other');
  git(main, 'worktree', 'add', '-qb', 'other', other);
  writeFileSync(join(other, '.env.override'), 'CLIENT_PORT=16000\n');
  await setup(worktree).catch(() => undefined);
  expect(readFileSync(join(worktree, '.env.override'), 'utf8')).toBe('CLIENT_PORT=17000\nAPI_PORT=17001\nAPI_URL=http://127.0.0.1:17001\n');
});

test('setup in the main checkout changes nothing', async () => {
  const { main } = repoWithWorktree('CLIENT_PORT=6000\n');
  expect(await setup(main)).toBe('Main checkout: nothing to set up.');
  expect(existsSync(join(main, '.env.override'))).toBe(false);
});

const entry: Entry = { path: '/w', head: 'abc', branch: 'feature', locked: false, prunable: false, main: false };
const facts = { exists: true, dirty: false, busy: false, running: false, prsKnown: true };
const pr = { number: 7, headRefName: 'feature', headRefOid: 'abc', url: 'https://github.com/o/r/pull/7' };

test('gc removes a worktree only when a merged PR holds its commits and nothing uses it', () => {
  expect(classify(entry, { ...facts, pr })).toEqual({ remove: true, pr, why: 'merged in https://github.com/o/r/pull/7' });
  expect(classify(entry, facts)).toEqual({ remove: false, why: 'no merged PR holds feature' });
  expect(classify(entry, { ...facts, pr, dirty: true })).toEqual({ remove: false, why: 'uncommitted or untracked files' });
  expect(classify(entry, { ...facts, pr, busy: true })).toEqual({ remove: false, why: 'a process is running in it' });
  expect(classify(entry, { ...facts, pr, running: true })).toEqual({ remove: false, why: 'a T3 run is active in it' });
  expect(classify(entry, { ...facts, pr, prsKnown: false })).toEqual({ remove: false, why: 'gh could not list PRs' });
  expect(classify({ ...entry, locked: true }, { ...facts, pr })).toEqual({ remove: false, why: 'locked' });
  expect(classify({ ...entry, prunable: true }, { ...facts, exists: false })).toEqual({ remove: true, why: 'its directory is gone' });
});
