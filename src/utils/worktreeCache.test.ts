import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './shell';
import {
	cleanIdleWorktreeCaches,
	cleanStaleRepoCaches,
	cleanWorktreeCache,
	DAY_MS,
	runningT3Worktree,
} from './worktreeCache';

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-cache-test-')));
	temporary.push(dir);
	const main = join(dir, 'main');
	mkdirSync(main);
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
	return { dir, main, worktree, cache };
}

const idle = { isRunning: () => false, openPaths: () => [] };

test('cache cleanup removes ignored build output on a detached worktree without touching source, env or database files', () => {
	const { worktree, cache } = fixture();
	git(worktree, 'checkout', '--detach', '-q');
	writeFileSync(join(worktree, 'source.txt'), 'uncommitted source');
	writeFileSync(join(worktree, '.env.local'), 'private');
	writeFileSync(join(worktree, 'app.sqlite'), 'user data');
	cleanWorktreeCache(worktree, idle);
	expect(existsSync(cache)).toBe(false);
	for (const file of ['source.txt', '.env.local', 'app.sqlite', '.git'])
		expect(existsSync(join(worktree, file))).toBe(true);
});

test('a dry run or the main checkout keeps build output', () => {
	const { main, worktree, cache } = fixture();
	cleanWorktreeCache(worktree, { ...idle, dryRun: true });
	expect(existsSync(cache)).toBe(true);
	mkdirSync(join(main, 'DerivedData'));
	cleanWorktreeCache(main, idle);
	expect(existsSync(join(main, 'DerivedData'))).toBe(true);
});

test('tracked files, symlinks, active runs and open build files block deletion', () => {
	const { dir, worktree, cache } = fixture();
	cleanWorktreeCache(worktree, { ...idle, isRunning: () => true });
	expect(existsSync(cache)).toBe(true);
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
	db.exec(
		'CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)',
	);
	for (const [id, status] of [
		['parent', 'completed'],
		['child', 'running'],
	]) {
		db.query('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run(
			id!,
			JSON.stringify({ worktreePath: worktree }),
		);
		db.query('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)').run(id!, status!);
	}
	expect(runningT3Worktree(worktree, file)).toBe(true);
	db.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed'");
	expect(runningT3Worktree(worktree, file)).toBe(false);
	db.close();
});

test('inspection failures leave build output untouched', () => {
	const { dir, worktree, cache } = fixture();
	expect(() =>
		cleanWorktreeCache(worktree, {
			...idle,
			openPaths: () => {
				throw new Error('lsof unavailable');
			},
		}),
	).toThrow('lsof unavailable');
	const database = join(dir, 'broken.sqlite');
	writeFileSync(database, 'not a database');
	expect(() =>
		cleanWorktreeCache(worktree, { ...idle, isRunning: root => runningT3Worktree(root, database) }),
	).toThrow();
	expect(existsSync(cache)).toBe(true);
});

test('runningT3Worktree detects active main-checkout runs via projection_projects without confusing them with a linked worktree', () => {
	const { dir, main, worktree } = fixture();
	const file = join(dir, 'statev2.sqlite');
	const db = new Database(file);
	db.exec(`
		CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT);
		CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT);
		CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
	`);
	db.query('INSERT INTO projection_projects VALUES (?, ?)').run('p1', main);
	db.query('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run(
		'wt-thread',
		JSON.stringify({ projectId: 'p1', worktreePath: worktree }),
	);
	db.query('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)').run('wt-thread', 'running');
	expect(runningT3Worktree(worktree, file)).toBe(true);
	expect(runningT3Worktree(main, file)).toBe(false);

	db.query('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)').run(
		'main-thread',
		JSON.stringify({ projectId: 'p1', worktreePath: null }),
	);
	db.query('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)').run('main-thread', 'running');
	expect(runningT3Worktree(main, file)).toBe(true);
	db.close();
});

test('stale repo cache cleanup keeps SourcePackages while a sibling DerivedData build is fresh and deletes DerivedData once all builds are stale', () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'repo-cache-test-')));
	temporary.push(dir);
	const repo = join(dir, 'app');
	mkdirSync(repo);
	git(repo, 'init', '-q');
	writeFileSync(join(repo, '.gitignore'), 'app-ios/DerivedData/\n.build/\n');
	writeFileSync(join(repo, 'source.txt'), 'source');
	git(repo, 'add', '.');
	git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');

	const derived = join(repo, 'app-ios/DerivedData');
	const sim = join(derived, 'simulator');
	const check = join(derived, 'check');
	const packages = join(derived, 'SourcePackages');
	const swiftBuild = join(repo, '.build');
	for (const path of [sim, check, packages, swiftBuild]) {
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'data.bin'), 'cache');
	}

	const stale = new Set([check, packages, swiftBuild]);
	cleanStaleRepoCaches({
		codeRoot: dir,
		minAgeMs: DAY_MS,
		...idle,
		isStale: entry => stale.has(entry),
		sizeOf: () => 1024,
	});
	expect(existsSync(check)).toBe(false);
	expect(existsSync(swiftBuild)).toBe(false);
	expect(existsSync(sim)).toBe(true);
	expect(existsSync(packages)).toBe(true);

	stale.add(sim);
	cleanStaleRepoCaches({
		codeRoot: dir,
		minAgeMs: DAY_MS,
		...idle,
		isStale: entry => stale.has(entry),
		sizeOf: () => 1024,
	});
	expect(existsSync(derived)).toBe(false);
	expect(existsSync(join(repo, 'source.txt'))).toBe(true);
});

test('stale repo cache cleanup keeps caches held by a live build lock or listed in keep', () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'repo-lock-test-')));
	temporary.push(dir);
	const repo = join(dir, 'app');
	mkdirSync(repo);
	git(repo, 'init', '-q');
	writeFileSync(join(repo, '.gitignore'), 'DerivedData/\n');
	writeFileSync(join(repo, 'source.txt'), 'source');
	git(repo, 'add', '.');
	git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');

	const sim = join(repo, 'DerivedData/simulator');
	mkdirSync(join(sim, '.build-lock'), { recursive: true });
	writeFileSync(join(sim, '.build-lock/pid'), String(process.pid));

	cleanStaleRepoCaches({ codeRoot: dir, minAgeMs: DAY_MS, ...idle, isStale: () => true, sizeOf: () => 1024 });
	expect(existsSync(sim)).toBe(true);

	rmSync(join(sim, '.build-lock'), { recursive: true });
	cleanStaleRepoCaches({
		codeRoot: dir,
		minAgeMs: DAY_MS,
		keep: [repo],
		...idle,
		isStale: () => true,
		sizeOf: () => 1024,
	});
	expect(existsSync(sim)).toBe(true);
});

test('idle worktree cache cleanup skips kept worktrees, active runs, and fresh caches when minAgeMs is set', () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'idle-wt-cache-test-')));
	temporary.push(dir);
	const main = join(dir, 'main');
	mkdirSync(main);
	git(main, 'init', '-q');
	writeFileSync(join(main, '.gitignore'), 'DerivedData/\n');
	writeFileSync(join(main, 'a.txt'), 'a');
	git(main, 'add', '.');
	git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');

	const worktreesRoot = join(dir, 'worktrees');
	const makeWorktree = (name: string) => {
		const wt = join(worktreesRoot, 'proj', name);
		git(main, 'worktree', 'add', '-qb', name, wt);
		const cache = join(wt, 'DerivedData');
		mkdirSync(cache, { recursive: true });
		writeFileSync(join(cache, 'x.bin'), 'x');
		return { wt, cache };
	};
	const kept = makeWorktree('kept');
	const active = makeWorktree('active');
	const fresh = makeWorktree('fresh');
	const stale = makeWorktree('stale');

	cleanIdleWorktreeCaches({
		worktreesRoot,
		keep: [kept.wt],
		minAgeMs: DAY_MS,
		isRunning: root => root === active.wt,
		openPaths: () => [],
		isStale: entry => entry === stale.cache,
		sizeOf: () => 1024,
	});
	expect(existsSync(kept.cache)).toBe(true);
	expect(existsSync(active.cache)).toBe(true);
	expect(existsSync(fresh.cache)).toBe(true);
	expect(existsSync(stale.cache)).toBe(false);

	// Emergency reclaim (minAgeMs: 0) also drops fresh caches in idle sibling worktrees, while still respecting keep/active.
	cleanIdleWorktreeCaches({
		worktreesRoot,
		keep: [kept.wt],
		minAgeMs: 0,
		isRunning: root => root === active.wt,
		openPaths: () => [],
		sizeOf: () => 1024,
	});
	expect(existsSync(fresh.cache)).toBe(false);
	expect(existsSync(kept.cache)).toBe(true);
	expect(existsSync(active.cache)).toBe(true);
});
