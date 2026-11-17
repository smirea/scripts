import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syncFork, type Fork } from './fork-sync';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(
		['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
		{ cwd, env: process.env },
	);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string): void {
	writeFileSync(path.join(cwd, file), content);
	git(cwd, 'add', file);
	git(cwd, 'commit', '-qm', `${file}: ${content}`);
}

/** An upstream with one commit, a fork of it on origin with one commit of ours, and a checkout of the fork. */
function setup() {
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
	const fork: Fork = { name: 't', dir: checkout, branch: 'main', upstream: 'upstream' };
	return { upstream, checkout, fork };
}

const quiet = () => {};

test('a rebase conflict is aborted, leaving the fork checkout as it was, and reports blocked', async () => {
	const { upstream, checkout, fork } = setup();
	commit(upstream, 'ours.txt', 'upstream edits the same file');
	const before = git(checkout, 'rev-parse', 'HEAD');
	expect((await syncFork(fork, quiet)).kind).toBe('blocked');
	expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
	expect(git(checkout, 'status', '--porcelain')).toBe('');
});

test('uncommitted changes in the fork checkout block the sync before anything moves', async () => {
	const { upstream, checkout, fork } = setup();
	commit(upstream, 'theirs.txt', 'upstream change');
	writeFileSync(path.join(checkout, 'ours.txt'), 'edited');
	const before = git(checkout, 'rev-parse', 'HEAD');
	expect((await syncFork(fork, quiet)).kind).toBe('blocked');
	expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
});
