import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syncFork, type Fork } from './fork-sync';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', `${file}: ${content}`);
}

/** An upstream with one commit, a fork of it on origin with one commit of ours, and a checkout of the fork. */
function setup(installMarker?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'fork-sync-'));
  dirs.push(root);
  const upstream = path.join(root, 'upstream');
  const checkout = path.join(root, 'checkout');
  git(root, 'init', '-q', upstream);
  commit(upstream, 'shared.txt', 'base');
  git(root, 'init', '-q', '--bare', path.join(root, 'origin.git'));
  git(root, 'clone', '-q', upstream, checkout);
  git(checkout, 'remote', 'rename', 'origin', 'upstream');
  git(checkout, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
  commit(checkout, 'ours.txt', 'fork change');
  git(checkout, 'push', '-q', 'origin', 'main');
  const fork: Fork = { name: 't', dir: checkout, branch: 'main', upstream: 'upstream', install: installMarker ? ['touch', installMarker] : undefined };
  return { root, upstream, checkout, fork };
}

const quiet = () => {};

test('rebases our commits onto new upstream commits and pushes', async () => {
  const marker = path.join(tmpdir(), `fork-sync-installed-${process.pid}`);
  const { upstream, checkout, fork, root } = setup(marker);
  commit(upstream, 'theirs.txt', 'upstream change');
  expect((await syncFork(fork, quiet)).kind).toBe('ok');
  expect(git(checkout, 'log', '--format=%s', '-3').split('\n')).toEqual(['ours.txt: fork change', 'theirs.txt: upstream change', 'shared.txt: base']);
  expect(git(path.join(root, 'origin.git'), 'rev-parse', 'main')).toBe(git(checkout, 'rev-parse', 'HEAD'));
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
});

test('a conflict aborts the rebase, leaves the checkout clean and reports blocked', async () => {
  const { upstream, checkout, fork } = setup();
  commit(upstream, 'ours.txt', 'upstream edits the same file');
  const before = git(checkout, 'rev-parse', 'HEAD');
  const outcome = await syncFork(fork, quiet);
  expect(outcome.kind).toBe('blocked');
  expect(outcome.detail).toContain('ours.txt');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(checkout, 'status', '--porcelain')).toBe('');
});

test('uncommitted changes block without fetching', async () => {
  const { checkout, fork } = setup();
  writeFileSync(path.join(checkout, 'ours.txt'), 'edited');
  expect((await syncFork(fork, quiet)).kind).toBe('blocked');
});

test('an unreachable upstream fails without blocking', async () => {
  const { checkout, fork } = setup();
  git(checkout, 'remote', 'set-url', 'upstream', '/nonexistent/upstream');
  expect((await syncFork(fork, quiet)).kind).toBe('failed');
});

test('a failed install is retried on the next run even when nothing moved', async () => {
  const { fork } = setup();
  fork.install = ['false'];
  expect((await syncFork(fork, quiet)).kind).toBe('failed');
  const marker = path.join(tmpdir(), `fork-sync-retry-${process.pid}`);
  fork.install = ['touch', marker];
  expect((await syncFork(fork, quiet)).kind).toBe('ok');
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
});
