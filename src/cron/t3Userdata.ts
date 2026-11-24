import { Database } from 'bun:sqlite';
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { allocated, freeBytes, human } from '../utils/disk';
import { DAY_MS, isPathStale, openFiles } from '../utils/worktreeCache';

export const DEFAULT_T3_USERDATA = join(homedir(), '.t3/userdata');
export const MIN_VACUUM_RECLAIM_BYTES = 100 * 1024 * 1024;
export const MIN_WAL_CHECKPOINT_BYTES = 32 * 1024 * 1024;
export const MIN_VACUUM_FREE_FLOOR_BYTES = 2 * 1024 ** 3;
const T3_LOG_LIMIT = 20 * 1024 * 1024;
const T3_LOG_KEEP = 2 * 1024 * 1024;

function isOpen(target: string, opened: string[]): boolean {
	return opened.some(path => path === target || path.startsWith(`${target}${sep}`));
}

function pruneDirEntries(
	dir: string,
	options: {
		dryRun: boolean;
		minAgeMs: number;
		opened: string[];
		isStale: (entry: string, minAgeMs: number) => boolean;
		sizeOf: (entry: string) => number;
		filter?: (name: string) => boolean;
	},
): { count: number; bytes: number } {
	if (!existsSync(dir)) return { count: 0, bytes: 0 };
	let count = 0;
	let bytes = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (options.filter && !options.filter(entry.name)) continue;
		const full = join(dir, entry.name);
		const stat = lstatSync(full);
		if (stat.isSymbolicLink() || isOpen(full, options.opened)) continue;
		if (!options.isStale(full, options.minAgeMs)) continue;
		bytes += options.sizeOf(full);
		if (!options.dryRun) rmSync(full, { recursive: true, force: true });
		count += 1;
	}
	return { count, bytes };
}

function trimOversizedFile(
	file: string,
	dryRun: boolean,
	limit = T3_LOG_LIMIT,
	keep = T3_LOG_KEEP,
): string | undefined {
	if (!existsSync(file)) return undefined;
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size <= limit) return undefined;
	if (!dryRun) {
		const tail = Buffer.alloc(keep);
		const fd = openSync(file, 'r');
		try {
			readSync(fd, tail, 0, keep, stat.size - keep);
		} finally {
			closeSync(fd);
		}
		writeFileSync(file, tail);
	}
	return `${dryRun ? 'would trim' : 'trimmed'} ${file} from ${human(stat.size)} to its last ${human(keep)}`;
}

export type T3ArtifactOptions = {
	userdataDir?: string;
	dryRun?: boolean;
	minAgeMs?: number;
	openPaths?: () => string[];
	isStale?: (entry: string, minAgeMs: number) => boolean;
	sizeOf?: (entry: string) => number;
	logLimitBytes?: number;
	logKeepBytes?: number;
};

/**
 * Prunes stale (>24h) disposable T3 Code userdata artifacts: browser screenshots, antigravity temp run dirs,
 * provider/terminal logs, and rotated top-level logs. Active unrotated top-level logs are only trimmed in place if
 * over 20 MB; settings, secrets, attachments, providers, and state databases are never removed here.
 */
export function pruneStaleT3Artifacts(options: T3ArtifactOptions = {}): string[] {
	const userdataDir = options.userdataDir ?? DEFAULT_T3_USERDATA;
	if (!existsSync(userdataDir)) return [`${userdataDir} is missing`];
	const dryRun = options.dryRun ?? false;
	const minAgeMs = options.minAgeMs ?? DAY_MS;
	const checkStale = options.isStale ?? isPathStale;
	const sizeOf = options.sizeOf ?? allocated;
	const opened = (options.openPaths ?? openFiles)();

	const lines: string[] = [];
	const shared = { dryRun, minAgeMs, opened, isStale: checkStale, sizeOf };

	const browser = pruneDirEntries(join(userdataDir, 'browser-artifacts'), shared);
	if (browser.count)
		lines.push(
			`${dryRun ? 'would delete' : 'deleted'} ${browser.count} browser artifacts over a day old (${human(browser.bytes)})`,
		);

	const antigravityTmp = join(userdataDir, 'antigravity-tmp');
	let tmpCount = 0;
	let tmpBytes = 0;
	if (existsSync(antigravityTmp)) {
		for (const entry of readdirSync(antigravityTmp, { withFileTypes: true })) {
			const full = join(antigravityTmp, entry.name);
			const stat = lstatSync(full);
			if (stat.isSymbolicLink() || isOpen(full, opened)) continue;
			if (stat.isDirectory()) {
				// Each profile directory holds per-run subdirectories; check them individually so one active run doesn't pin old runs.
				const sub = pruneDirEntries(full, shared);
				tmpCount += sub.count;
				tmpBytes += sub.bytes;
				if (!dryRun && readdirSync(full).length === 0 && checkStale(full, minAgeMs)) {
					rmSync(full, { recursive: true, force: true });
				}
			} else if (checkStale(full, minAgeMs)) {
				tmpBytes += sizeOf(full);
				if (!dryRun) rmSync(full, { force: true });
				tmpCount += 1;
			}
		}
	}
	if (tmpCount)
		lines.push(
			`${dryRun ? 'would delete' : 'deleted'} ${tmpCount} antigravity-tmp entries over a day old (${human(tmpBytes)})`,
		);

	const logsDir = join(userdataDir, 'logs');
	if (existsSync(logsDir)) {
		const providerLogs = pruneDirEntries(join(logsDir, 'provider'), shared);
		const terminalLogs = pruneDirEntries(join(logsDir, 'terminals'), shared);
		const rotatedLogs = pruneDirEntries(logsDir, { ...shared, filter: name => /\.\d+$/.test(name) });
		const logCount = providerLogs.count + terminalLogs.count + rotatedLogs.count;
		const logBytes = providerLogs.bytes + terminalLogs.bytes + rotatedLogs.bytes;
		if (logCount)
			lines.push(`${dryRun ? 'would delete' : 'deleted'} ${logCount} T3 log files over a day old (${human(logBytes)})`);

		for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
			if (!entry.isFile() || /\.\d+$/.test(entry.name)) continue;
			const trimmed = trimOversizedFile(
				join(logsDir, entry.name),
				dryRun,
				options.logLimitBytes ?? T3_LOG_LIMIT,
				options.logKeepBytes ?? T3_LOG_KEEP,
			);
			if (trimmed) lines.push(trimmed);
		}
	}

	return lines.length ? lines : [`nothing in ${userdataDir} disposable caches/logs is over a day old`];
}

export type T3DatabaseCompactOptions = {
	dbPath?: string;
	dryRun?: boolean;
	minReclaimBytes?: number;
	minWalBytes?: number;
	minFreeFloorBytes?: number;
	freeSpace?: () => number;
};

function isBusyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /SQLITE_BUSY|database is locked/i.test(message);
}

/**
 * Reclaims uncompacted freelist pages and oversized WAL files in T3 Code's `statev2.sqlite`.
 * Refuses to touch the DB while any T3 run is active or when free disk is under 2x DB size, so `VACUUM`
 * can never stall an active run or trigger `SQLITE_FULL`.
 */
export function compactT3Database(options: T3DatabaseCompactOptions = {}): string[] {
	const dbPath = options.dbPath ?? join(DEFAULT_T3_USERDATA, 'statev2.sqlite');
	if (!existsSync(dbPath)) return [`${dbPath} is missing`];

	const dryRun = options.dryRun ?? false;
	const minReclaimBytes = options.minReclaimBytes ?? MIN_VACUUM_RECLAIM_BYTES;
	const minWalBytes = options.minWalBytes ?? MIN_WAL_CHECKPOINT_BYTES;
	const minFreeFloorBytes = options.minFreeFloorBytes ?? MIN_VACUUM_FREE_FLOOR_BYTES;
	const freeSpace = options.freeSpace ?? freeBytes;

	let pageSize = 0;
	let freelistCount = 0;
	let activeRuns = 0;
	const ro = new Database(dbPath, { readonly: true });
	try {
		pageSize = (ro.query('PRAGMA page_size').get() as { page_size: number } | null)?.page_size ?? 4096;
		freelistCount = (ro.query('PRAGMA freelist_count').get() as { freelist_count: number } | null)?.freelist_count ?? 0;
		const hasRunsTable =
			ro
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_projection_runs' LIMIT 1")
				.get() !== null;
		if (hasRunsTable) {
			activeRuns =
				(
					ro
						.query(
							"SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'rolled_back')",
						)
						.get() as { count: number } | null
				)?.count ?? 0;
		}
	} finally {
		ro.close();
	}

	const walPath = `${dbPath}-wal`;
	const dbBytes = statSync(dbPath).size;
	const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
	const freelistBytes = freelistCount * pageSize;
	const needsVacuum = freelistBytes >= minReclaimBytes;
	const needsCheckpoint = walBytes >= minWalBytes;

	if (!needsVacuum && !needsCheckpoint) {
		return [`statev2.sqlite: clean (${human(dbBytes)}, ${human(freelistBytes)} freelist, ${human(walBytes)} WAL)`];
	}
	if (activeRuns > 0) {
		return [
			`statev2.sqlite: skipped (${activeRuns} active T3 ${activeRuns === 1 ? 'run' : 'runs'}; ${human(freelistBytes)} freelist in ${human(dbBytes)} DB, ${human(walBytes)} WAL)`,
		];
	}
	if (needsVacuum) {
		const requiredFree = Math.max(dbBytes * 2, minFreeFloorBytes);
		const available = freeSpace();
		if (available < requiredFree) {
			return [
				`statev2.sqlite: skipped VACUUM (need ${human(requiredFree)} free for ${human(dbBytes)} DB, only ${human(available)} free)`,
			];
		}
	}
	if (dryRun) {
		return [
			needsVacuum
				? `statev2.sqlite: would VACUUM and checkpoint WAL (${human(dbBytes)}, ~${human(freelistBytes)} freelist reclaimable, ${human(walBytes)} WAL)`
				: `statev2.sqlite: would checkpoint WAL (${human(walBytes)} WAL)`,
		];
	}

	const rw = new Database(dbPath);
	try {
		rw.exec('PRAGMA busy_timeout = 5000;');
		rw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		if (needsVacuum) {
			rw.exec('VACUUM;');
			// In WAL mode, VACUUM leaves a full-sized WAL until checkpointed again.
			rw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
		}
	} catch (error) {
		if (isBusyError(error)) return ['statev2.sqlite: skipped (database is busy)'];
		throw error;
	} finally {
		rw.close();
	}

	const afterDbBytes = statSync(dbPath).size;
	const afterWalBytes = existsSync(walPath) ? statSync(walPath).size : 0;
	const beforeTotal = dbBytes + walBytes;
	const afterTotal = afterDbBytes + afterWalBytes;
	const reclaimed = Math.max(0, beforeTotal - afterTotal);
	return [
		`statev2.sqlite: ${needsVacuum ? 'compacted' : 'checkpointed WAL'} ${human(beforeTotal)} → ${human(afterTotal)} (${human(reclaimed)} reclaimed)`,
	];
}

export function cleanT3Userdata(options: T3ArtifactOptions & T3DatabaseCompactOptions = {}): string[] {
	const userdataDir = options.userdataDir ?? DEFAULT_T3_USERDATA;
	const dbPath = options.dbPath ?? join(userdataDir, 'statev2.sqlite');
	return [...pruneStaleT3Artifacts({ ...options, userdataDir }), ...compactT3Database({ ...options, dbPath })];
}
