import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { DEFAULT_RECLAIM_WATERMARK_GB, pruneAbandoned, reclaimDisk } from '../utils/agentWorktree';
import { run } from '../utils/shell';
import { gc as simulatorGc } from '../utils/simulators';
import { cleanRepoBuildCaches, isPathStale } from '../utils/worktreeCache';
import { allocated, human, LOG_FILE, STATE_DIR, type Step } from './steps';
import { cleanT3Userdata } from './t3Userdata';

const home = homedir();
const TRASH = path.join(home, '.Trash');
const TMP = '/private/tmp';
const DERIVED_DATA = path.join(home, 'Library/Developer/Xcode/DerivedData');
const PLAYWRIGHT_CACHE = path.join(home, 'Library/Caches/ms-playwright');
const TCC_DATABASE = path.join(home, 'Library/Application Support/com.apple.TCC/TCC.db');
const CONTAINER_ROOT = path.join(home, 'Library/Application Support/com.apple.container/containers');
const CONTAINER_LOGS = path.join(home, 'Library/Logs/repo-containers');
const REPO_CONTAINERS_STATE = path.join(home, 'code/.repo-containers');
const PACKAGE_STAMP = path.join(STATE_DIR, 'last-package-prune');
const WEEK_MS = 7 * 24 * 60 * 60_000;
const LOG_LIMIT = 20 * 1024 * 1024;
const LOG_KEEP = 2 * 1024 * 1024;
const BLOATED_CONTAINER = 4 * 1024 * 1024 * 1024;

export const CLEANUP_STEPS: Step[] = [
	{
		name: 't3 worktrees',
		action: dryRun => [...pruneAbandoned({ dryRun }), ...simulatorGc({ dryRun })],
	},
	{ name: 'repo build caches', action: dryRun => cleanRepoBuildCaches({ dryRun }) },
	{ name: 'repo containers', action: containers },
	{
		name: 'logs',
		action: dryRun => [...trimLogs(CONTAINER_LOGS, dryRun), ...trimLog(LOG_FILE, dryRun)],
	},
	{ name: '/tmp', action: dryRun => removeStale(TMP, dryRun) },
	{ name: 'xcode derived data', action: dryRun => removeStale(DERIVED_DATA, dryRun) },
	{ name: 'playwright browsers', action: playwrightBrowsers },
	{ name: 'trash', action: emptyTrash },
	{ name: 't3 userdata', action: dryRun => cleanT3Userdata({ dryRun }) },
	{ name: 'package caches (weekly)', action: packageCaches },
	{
		name: 'low-disk watermark',
		action: dryRun => reclaimDisk({ minFreeGb: DEFAULT_RECLAIM_WATERMARK_GB, dryRun }),
	},
];

function containers(dryRun: boolean): string[] {
	if (!existsSync(REPO_CONTAINERS_STATE))
		return [`this Mac hosts no repo containers (${REPO_CONTAINERS_STATE} is missing)`];
	if (!Bun.which('setup-repo-container'))
		throw new Error('`setup-repo-container` is not on PATH; it is ~/bin/setup-repo-container from ~/code/home-mac.');
	const report: string[] = [];
	const running = run(['container', 'list', '--quiet']).split('\n').filter(Boolean);
	for (const app of running.filter(id => id.startsWith('paas-'))) {
		// Blocks the app freed inside its VM stay allocated on the Mac until they are trimmed.
		if (dryRun) report.push(`would trim ${app}`);
		else run(['container', 'exec', app, 'fstrim', '/'], { allowFail: true });
	}
	if (dryRun) report.push('would run `setup-repo-container cleanup` (unused images, BuildKit cache over 2 GB)');
	else report.push(run(['setup-repo-container', 'cleanup']).split('\n').at(-1)!);
	for (const id of readdirSync(CONTAINER_ROOT)) {
		const bytes = allocated(path.join(CONTAINER_ROOT, id));
		const state = running.includes(id) ? 'running' : 'stopped';
		const flag = bytes > BLOATED_CONTAINER ? '  BLOATED: check what it writes to its disk' : '';
		report.push(`${id} (${state}): ${human(bytes)}${flag}`);
	}
	return report;
}

function trimLogs(dir: string, dryRun: boolean): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith('.log'))
		.flatMap(name => trimLog(path.join(dir, name), dryRun));
}

// launchd opens StandardOutPath for appending, so a log it is writing can be cut in place.
function trimLog(file: string, dryRun: boolean): string[] {
	if (!existsSync(file)) return [];
	const bytes = statSync(file).size;
	if (bytes <= LOG_LIMIT) return [];
	if (!dryRun) {
		const tail = Buffer.alloc(LOG_KEEP);
		const fd = openSync(file, 'r');
		readSync(fd, tail, 0, LOG_KEEP, bytes - LOG_KEEP);
		closeSync(fd);
		writeFileSync(file, tail);
	}
	return [`${dryRun ? 'would trim' : 'trimmed'} ${file} from ${human(bytes)} to its last ${human(LOG_KEEP)}`];
}

function packageCaches(dryRun: boolean): string[] {
	const last = existsSync(PACKAGE_STAMP) ? statSync(PACKAGE_STAMP).mtimeMs : undefined;
	if (last && Date.now() - last < WEEK_MS)
		return [`skipped: last pruned ${new Date(last).toLocaleString()}, under a week ago`];
	for (const tool of ['pnpm', 'bun'])
		if (!Bun.which(tool)) throw new Error(`\`${tool}\` is not on PATH; rerun \`cron install\` to refresh its PATH.`);
	const store = run(['pnpm', 'store', 'path']);
	const bunCache = run(['bun', 'pm', 'cache']).split('\n').at(-1)!;
	// pnpm only prunes its current store version; a store left by an older major version is never read again.
	const oldStores = readdirSync(path.dirname(store))
		.filter(name => /^v\d+$/.test(name) && name !== path.basename(store))
		.map(name => path.join(path.dirname(store), name));
	const before = allocated(store) + allocated(bunCache) + oldStores.reduce((sum, dir) => sum + allocated(dir), 0);
	if (dryRun)
		return [
			`would run \`pnpm store prune\`, delete ${oldStores.length} old pnpm stores, and clear the bun cache (${human(before)} now)`,
		];
	run(['pnpm', 'store', 'prune']);
	for (const dir of oldStores) run(['rm', '-rf', dir]);
	// bun has no prune: clearing is the only way to drop packages no project uses anymore.
	run(['bun', 'pm', 'cache', 'rm']);
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(PACKAGE_STAMP, new Date().toISOString());
	const after = allocated(store) + allocated(bunCache);
	return [
		`pruned the pnpm store, ${oldStores.length} old pnpm stores, and the bun cache: ${human(before)} → ${human(after)}`,
	];
}

/**
 * Removes each top-level entry of `dir` as a whole once nothing inside it was modified or changed in the last day.
 * ctime counts because extracted archives keep old mtimes; sockets and FIFOs keep their entry because a live process owns them.
 */
function removeStale(dir: string, dryRun: boolean): string[] {
	if (!existsSync(dir)) return [`${dir} is missing`];
	const uid = process.getuid!();
	const stale = readdirSync(dir)
		.map(name => path.join(dir, name))
		.filter(entry => lstatSync(entry).uid === uid)
		.filter(entry => isPathStale(entry));
	if (!stale.length) return [`nothing in ${dir} is over a day old`];
	const bytes = stale.reduce((sum, entry) => sum + allocated(entry), 0);
	const failed = dryRun ? [] : removeAll(stale);
	return [
		...(dryRun ? stale.map(entry => `would delete ${entry}`) : []),
		`${dryRun ? 'would delete' : 'deleted'} ${stale.length - failed.length} entries in ${dir} over a day old (${human(bytes)})`,
		...failed.map(entry => `could not fully delete ${entry}; check its permissions`),
	];
}

/** Returns the entries still there after `rm -rf`. */
function removeAll(entries: string[]): string[] {
	return entries.filter(entry => !run(['rm', '-rf', entry], { allowFail: true }) && existsSync(entry));
}

/**
 * Playwright records each install that downloaded browsers in `.links`, and only prunes the rest on its next install.
 * This does that prune now: browsers no live install's browsers.json names go, along with links to removed installs.
 */
function playwrightBrowsers(dryRun: boolean): string[] {
	const links = path.join(PLAYWRIGHT_CACHE, '.links');
	if (!existsSync(links)) return [`no Playwright browsers (${links} is missing)`];
	const keep = new Set<string>();
	const deadLinks: string[] = [];
	for (const name of readdirSync(links)) {
		const install = readFileSync(path.join(links, name), 'utf8').trim();
		const manifest = path.join(install, 'browsers.json');
		if (!existsSync(manifest)) {
			deadLinks.push(path.join(links, name));
			continue;
		}
		const { browsers } = JSON.parse(readFileSync(manifest, 'utf8')) as {
			browsers: { name: string; revision: string; revisionOverrides?: Record<string, string> }[];
		};
		for (const browser of browsers)
			for (const revision of [browser.revision, ...Object.values(browser.revisionOverrides ?? {})])
				keep.add(`${browser.name.replaceAll('-', '_')}-${revision}`);
	}
	const unused = readdirSync(PLAYWRIGHT_CACHE)
		.filter(name => /^[a-z_]+-\d+$/.test(name) && !keep.has(name))
		.map(name => path.join(PLAYWRIGHT_CACHE, name));
	const bytes = unused.reduce((sum, dir) => sum + allocated(dir), 0);
	const failed = dryRun ? [] : removeAll([...unused, ...deadLinks]);
	return [
		...(dryRun ? unused.map(dir => `would delete ${dir}`) : []),
		`${dryRun ? 'would delete' : 'deleted'} ${unused.length} unused Playwright browsers (${human(bytes)}) and ${deadLinks.length} links to removed installs`,
		...failed.map(entry => `could not delete ${entry}; check its permissions`),
	];
}

// Without Full Disk Access macOS lists ~/.Trash as empty instead of failing, so a protected file is the probe.
function hasFullDiskAccess(): boolean {
	try {
		closeSync(openSync(TCC_DATABASE, 'r'));
		return true;
	} catch {
		return false;
	}
}

function emptyTrash(dryRun: boolean): string[] {
	if (!hasFullDiskAccess())
		throw new Error(
			`Without Full Disk Access macOS hides what is in ${TRASH}. Grant it to ${realpathSync(process.execPath)} in System Settings → Privacy & Security → Full Disk Access (+, then ⌘⇧G and paste the path), and to your terminal app for manual runs.`,
		);
	const items = readdirSync(TRASH).filter(name => name !== '.DS_Store');
	if (!items.length) return ['Trash is empty'];
	const bytes = allocated(TRASH);
	if (!dryRun) for (const name of items) run(['rm', '-rf', path.join(TRASH, name)]);
	return [`${dryRun ? 'would delete' : 'deleted'} ${items.length} items in the Trash (${human(bytes)})`];
}
