import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

import { allocated, human } from './disk';

export const DAY_MS = 24 * 60 * 60_000;
const CACHE_NAMES = ['DerivedData', 'app-ios/DerivedData', '.build', 'app-ios/.build'] as const;

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
		const hasProjects =
			db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects' LIMIT 1").get() !==
			null;
		// Main-checkout threads leave worktreePath unset and resolve their workspace via projection_projects.
		const query = hasProjects
			? `
      SELECT 1 FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      LEFT JOIN projection_projects p ON p.project_id = json_extract(t.payload_json, '$.projectId')
      WHERE COALESCE(NULLIF(json_extract(t.payload_json, '$.worktreePath'), ''), p.workspace_root) = ?
        AND r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'rolled_back')
      LIMIT 1
    `
			: `
      SELECT 1 FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE json_extract(t.payload_json, '$.worktreePath') = ?
        AND r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'rolled_back')
      LIMIT 1
    `;
		return db.query(query).get(root) !== null;
	} finally {
		db.close();
	}
}

export function openFiles() {
	const result = spawnSync('lsof', ['-nP', '-F', 'n'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error('Cannot inspect open files; leaving build caches alone.');
	return result.stdout
		.split('\n')
		.filter(line => line.startsWith('n'))
		.map(line => line.slice(1));
}

/**
 * True when nothing inside `entry` was modified or status-changed within `minAgeMs`, and no socket or FIFO lives inside it.
 * ctime counts because extracted archives keep old mtimes; an unreadable subtree makes `find` fail and keeps the entry.
 */
export function isPathStale(entry: string, minAgeMs = DAY_MS): boolean {
	if (!existsSync(entry)) return false;
	const stat = lstatSync(entry);
	if (stat.isSocket() || stat.isFIFO()) return false;
	if (!stat.isDirectory()) return Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) >= minAgeMs;
	const minutes = Math.max(1, Math.ceil(minAgeMs / 60_000));
	const result = spawnSync(
		'find',
		[
			entry,
			'(',
			'-mmin',
			`-${minutes}`,
			'-o',
			'-cmin',
			`-${minutes}`,
			'-o',
			'-type',
			's',
			'-o',
			'-type',
			'p',
			')',
			'-print',
			'-quit',
		],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
	);
	return result.status === 0 && !result.stdout.trim();
}

function hasLiveBuildLock(dir: string): boolean {
	const pidFile = join(dir, '.build-lock', 'pid');
	if (!existsSync(pidFile)) return false;
	try {
		const pid = Number(readFileSync(pidFile, 'utf8').trim());
		if (!pid) return true;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isOpen(target: string, opened: string[]): boolean {
	return opened.some(path => path === target || path.startsWith(`${target}${sep}`));
}

function isLocalIgnoredDir(root: string, name: string): { ok: true; cache: string } | { ok: false; reason: string } {
	const cache = join(root, name);
	if (!existsSync(cache)) return { ok: false, reason: 'missing' };
	// Only the known, wholly ignored build directory is disposable; never follow a link out of it.
	if (
		!lstatSync(cache).isDirectory() ||
		realpathSync(cache) !== cache ||
		relative(root, cache).startsWith(`..${sep}`)
	) {
		return { ok: false, reason: `Kept ${name}: not a local build directory.` };
	}
	const ignored = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', `${name}/`], { env: gitEnvironment() });
	if (ignored.status !== 0 || git(root, 'ls-files', '--', name)) {
		return { ok: false, reason: `Kept ${name}: contains tracked files or is not ignored.` };
	}
	return { ok: true, cache };
}

function normalizeKeep(keep: string[] = []): Set<string> {
	const set = new Set<string>();
	for (const path of keep) {
		if (!path) continue;
		try {
			set.add(realpathSync(path));
		} catch {
			set.add(resolve(path));
		}
	}
	return set;
}

export type CacheCleanupOptions = {
	dryRun?: boolean;
	minAgeMs?: number;
	isRunning?: (root: string) => boolean;
	openPaths?: () => string[];
	isStale?: (entry: string, minAgeMs: number) => boolean;
	sizeOf?: (entry: string) => number;
};

export function cleanWorktreeCache(directory: string, options: CacheCleanupOptions = {}) {
	const root = realpathSync(directory);
	if (git(root, 'rev-parse', '--show-toplevel') !== root) throw new Error('Pass the worktree root.');
	const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
	const commonDir = resolve(root, git(root, 'rev-parse', '--git-common-dir'));
	if (realpathSync(gitDir) === realpathSync(commonDir)) return ['Kept: main checkout.'];
	const isRunning = options.isRunning ?? runningT3Worktree;
	if (isRunning(root)) return ['Kept: a T3 run still uses this worktree.'];

	const paths = CACHE_NAMES.filter(name => existsSync(join(root, name)));
	if (!paths.length) return ['No worktree build caches.'];
	const opened = (options.openPaths ?? openFiles)();
	const checkStale = options.isStale ?? isPathStale;
	const minAgeMs = options.minAgeMs ?? 0;
	const messages: string[] = [];
	for (const name of paths) {
		const check = isLocalIgnoredDir(root, name);
		if (!check.ok) {
			if (check.reason !== 'missing') messages.push(check.reason);
			continue;
		}
		const { cache } = check;
		if (isOpen(cache, opened)) {
			messages.push(`Kept ${name}: still open in another process.`);
			continue;
		}
		if (hasLiveBuildLock(cache) || hasLiveChildBuildLock(cache)) {
			messages.push(`Kept ${name}: a build lock is held.`);
			continue;
		}
		if (minAgeMs > 0 && !checkStale(cache, minAgeMs)) {
			messages.push(`Kept ${name}: modified recently.`);
			continue;
		}
		if (isRunning(root)) {
			messages.push(`Kept ${name}: a T3 run started.`);
			continue;
		}
		if (!options.dryRun) rmSync(cache, { recursive: true, force: true });
		messages.push(`${options.dryRun ? 'Would remove' : 'Removed'} ${cache}`);
	}
	return messages;
}

function hasLiveChildBuildLock(cache: string): boolean {
	if (!existsSync(cache)) return false;
	for (const entry of readdirSync(cache, { withFileTypes: true })) {
		if (entry.isDirectory() && hasLiveBuildLock(join(cache, entry.name))) return true;
	}
	return false;
}

/**
 * Cleans gitignored `DerivedData` and `.build` directories across idle T3 linked worktrees.
 * Pass `minAgeMs: 0` for low-disk reclamation or `DAY_MS` for nightly cleanup.
 */
export function cleanIdleWorktreeCaches(
	options: CacheCleanupOptions & {
		worktreesRoot?: string;
		keep?: string[];
	} = {},
): string[] {
	const worktreesRoot = options.worktreesRoot ?? join(homedir(), '.t3/worktrees');
	if (!existsSync(worktreesRoot)) return [];
	const keep = normalizeKeep(options.keep);
	const isRunning = options.isRunning ?? runningT3Worktree;
	const checkStale = options.isStale ?? isPathStale;
	const sizeOf = options.sizeOf ?? allocated;
	const minAgeMs = options.minAgeMs ?? 0;

	const candidates: { root: string; caches: string[] }[] = [];
	for (const project of readdirSync(worktreesRoot, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = join(worktreesRoot, project.name);
		for (const dir of readdirSync(projectDir, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const worktree = join(projectDir, dir.name);
			let root: string;
			try {
				root = realpathSync(worktree);
				if (git(root, 'rev-parse', '--show-toplevel') !== root) continue;
				const gitDir = git(root, 'rev-parse', '--absolute-git-dir');
				const commonDir = resolve(root, git(root, 'rev-parse', '--git-common-dir'));
				if (realpathSync(gitDir) === realpathSync(commonDir)) continue;
			} catch {
				continue;
			}
			if (keep.has(root)) continue;
			const caches = CACHE_NAMES.filter(name => existsSync(join(root, name)));
			if (caches.length) candidates.push({ root, caches });
		}
	}
	if (!candidates.length) return ['No idle worktree build caches found.'];

	const opened = (options.openPaths ?? openFiles)();
	const lines: string[] = [];
	let totalBytes = 0;
	let removedCount = 0;

	for (const { root, caches } of candidates) {
		if (isRunning(root)) continue;
		for (const name of caches) {
			const check = isLocalIgnoredDir(root, name);
			if (!check.ok) continue;
			const { cache } = check;
			if (isOpen(cache, opened) || hasLiveBuildLock(cache) || hasLiveChildBuildLock(cache)) continue;
			if (minAgeMs > 0 && !checkStale(cache, minAgeMs)) continue;
			if (isRunning(root)) break;
			const bytes = sizeOf(cache);
			if (!options.dryRun) rmSync(cache, { recursive: true, force: true });
			totalBytes += bytes;
			removedCount += 1;
			lines.push(`${options.dryRun ? 'would remove' : 'removed'} ${cache} (${human(bytes)})`);
		}
	}

	if (!removedCount) return ['No stale idle worktree build caches to remove.'];
	lines.push(
		`${options.dryRun ? 'would reclaim' : 'reclaimed'} ${human(totalBytes)} across ${removedCount} worktree build ${removedCount === 1 ? 'cache' : 'caches'}`,
	);
	return lines;
}

/**
 * Cleans stale (`> minAgeMs`) gitignored `DerivedData` and `.build` caches in main checkouts under `codeRoot`.
 * Inside `DerivedData`, each top-level entry is evaluated individually and `SourcePackages` is kept while any sibling
 * build is still fresh, so an active simulator build doesn't force a multi-GB SwiftPM re-clone.
 */
export function cleanStaleRepoCaches(
	options: CacheCleanupOptions & {
		codeRoot?: string;
		keep?: string[];
	} = {},
): string[] {
	const codeRoot = options.codeRoot ?? join(homedir(), 'code');
	if (!existsSync(codeRoot)) return [];
	const keep = normalizeKeep(options.keep);
	const isRunning = options.isRunning ?? runningT3Worktree;
	const checkStale = options.isStale ?? isPathStale;
	const sizeOf = options.sizeOf ?? allocated;
	const minAgeMs = options.minAgeMs ?? DAY_MS;

	const repos: { root: string; caches: string[] }[] = [];
	for (const dir of readdirSync(codeRoot, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const full = join(codeRoot, dir.name);
		let root: string;
		try {
			root = realpathSync(full);
			if (root !== full && relative(codeRoot, root).startsWith(`..${sep}`)) continue;
			if (git(root, 'rev-parse', '--show-toplevel') !== root) continue;
		} catch {
			continue;
		}
		if (keep.has(root)) continue;
		const caches = CACHE_NAMES.filter(name => existsSync(join(root, name)));
		if (caches.length) repos.push({ root, caches });
	}
	if (!repos.length) return ['No repo build caches found.'];

	const opened = (options.openPaths ?? openFiles)();
	const lines: string[] = [];
	let totalBytes = 0;
	let removedCount = 0;

	for (const { root, caches } of repos) {
		if (isRunning(root)) continue;
		for (const name of caches) {
			const check = isLocalIgnoredDir(root, name);
			if (!check.ok) continue;
			const { cache } = check;
			if (hasLiveBuildLock(cache)) continue;

			if (basename(name) === 'DerivedData') {
				const entries = readdirSync(cache);
				const removable: string[] = [];
				let sourcePackages: string | undefined;
				let keptSibling = false;

				for (const entryName of entries) {
					const entryPath = join(cache, entryName);
					const stat = lstatSync(entryPath);
					if (
						stat.isSymbolicLink() ||
						isOpen(entryPath, opened) ||
						(stat.isDirectory() && hasLiveBuildLock(entryPath))
					) {
						if (entryName !== 'SourcePackages') keptSibling = true;
						continue;
					}
					if (entryName === 'SourcePackages') {
						sourcePackages = entryPath;
						continue;
					}
					if (checkStale(entryPath, minAgeMs)) removable.push(entryPath);
					else keptSibling = true;
				}

				if (sourcePackages && !keptSibling && checkStale(sourcePackages, minAgeMs)) removable.push(sourcePackages);
				if (!removable.length) continue;
				if (isRunning(root)) break;

				const removeWholeDir = !keptSibling && removable.length === entries.length && !isOpen(cache, opened);
				const targets = removeWholeDir ? [cache] : removable;
				for (const target of targets) {
					const bytes = sizeOf(target);
					if (!options.dryRun) rmSync(target, { recursive: true, force: true });
					totalBytes += bytes;
					removedCount += 1;
					lines.push(`${options.dryRun ? 'would remove' : 'removed'} ${target} (${human(bytes)})`);
				}
			} else {
				if (isOpen(cache, opened) || hasLiveChildBuildLock(cache)) continue;
				if (!checkStale(cache, minAgeMs)) continue;
				if (isRunning(root)) break;
				const bytes = sizeOf(cache);
				if (!options.dryRun) rmSync(cache, { recursive: true, force: true });
				totalBytes += bytes;
				removedCount += 1;
				lines.push(`${options.dryRun ? 'would remove' : 'removed'} ${cache} (${human(bytes)})`);
			}
		}
	}

	if (!removedCount) return [`No repo build caches in ${codeRoot} are over a day old.`];
	lines.push(
		`${options.dryRun ? 'would reclaim' : 'reclaimed'} ${human(totalBytes)} across ${removedCount} repo build ${removedCount === 1 ? 'cache' : 'caches'}`,
	);
	return lines;
}

export function cleanRepoBuildCaches(
	options: CacheCleanupOptions & {
		worktreesRoot?: string;
		codeRoot?: string;
		keep?: string[];
	} = {},
): string[] {
	const minAgeMs = options.minAgeMs ?? DAY_MS;
	const opened = (options.openPaths ?? openFiles)();
	const shared = { ...options, minAgeMs, openPaths: () => opened };
	return [...cleanIdleWorktreeCaches(shared), ...cleanStaleRepoCaches(shared)];
}
