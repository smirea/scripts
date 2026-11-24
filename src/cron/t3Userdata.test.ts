import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compactT3Database, pruneStaleT3Artifacts } from './t3Userdata';

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	temporary.push(dir);
	return dir;
}

test('stale T3 userdata pruning deletes old browser artifacts, antigravity-tmp runs, provider/terminal logs, and rotated logs while keeping fresh, open, active unrotated, and non-cache files', () => {
	const root = tempDir('t3-userdata-test-');
	const dirs = [
		'browser-artifacts',
		'antigravity-tmp/profileA/run-old',
		'antigravity-tmp/profileA/run-live',
		'logs/provider',
		'logs/terminals',
		'attachments',
	];
	for (const rel of dirs) mkdirSync(join(root, rel), { recursive: true });

	const oldShot = join(root, 'browser-artifacts/old.png');
	const freshShot = join(root, 'browser-artifacts/fresh.png');
	const oldRun = join(root, 'antigravity-tmp/profileA/run-old');
	const liveRun = join(root, 'antigravity-tmp/profileA/run-live');
	const oldProviderLog = join(root, 'logs/provider/events.old.log');
	const openProviderLog = join(root, 'logs/provider/events.open.log');
	const oldTerminalLog = join(root, 'logs/terminals/t1.log');
	const oldRotatedLog = join(root, 'logs/server.trace.ndjson.2');
	const activeUnrotatedLog = join(root, 'logs/server.trace.ndjson');
	const oversizedUnrotatedLog = join(root, 'logs/server-child.log');
	const settings = join(root, 'settings.json');
	const attachment = join(root, 'attachments/pic.png');

	for (const file of [
		oldShot,
		freshShot,
		join(oldRun, 'temp.dat'),
		join(liveRun, 'temp.dat'),
		oldProviderLog,
		openProviderLog,
		oldTerminalLog,
		oldRotatedLog,
		activeUnrotatedLog,
		settings,
		attachment,
	]) {
		writeFileSync(file, 'payload');
	}
	writeFileSync(oversizedUnrotatedLog, 'x'.repeat(2048));

	const staleSet = new Set([
		oldShot,
		oldRun,
		oldProviderLog,
		openProviderLog,
		oldTerminalLog,
		oldRotatedLog,
		activeUnrotatedLog,
		settings,
		attachment,
	]);

	// Dry run leaves every file intact.
	pruneStaleT3Artifacts({
		userdataDir: root,
		dryRun: true,
		openPaths: () => [openProviderLog],
		isStale: entry => staleSet.has(entry),
		sizeOf: () => 512,
		logLimitBytes: 1024,
		logKeepBytes: 256,
	});
	expect(existsSync(oldShot)).toBe(true);
	expect(statSync(oversizedUnrotatedLog).size).toBe(2048);

	pruneStaleT3Artifacts({
		userdataDir: root,
		openPaths: () => [openProviderLog],
		isStale: entry => staleSet.has(entry),
		sizeOf: () => 512,
		logLimitBytes: 1024,
		logKeepBytes: 256,
	});

	expect(existsSync(oldShot)).toBe(false);
	expect(existsSync(oldRun)).toBe(false);
	expect(existsSync(oldProviderLog)).toBe(false);
	expect(existsSync(oldTerminalLog)).toBe(false);
	expect(existsSync(oldRotatedLog)).toBe(false);

	expect(existsSync(freshShot)).toBe(true);
	expect(existsSync(liveRun)).toBe(true);
	expect(existsSync(openProviderLog)).toBe(true);
	expect(existsSync(activeUnrotatedLog)).toBe(true);
	expect(statSync(oversizedUnrotatedLog).size).toBe(256);
	expect(existsSync(settings)).toBe(true);
	expect(existsSync(attachment)).toBe(true);
});

test('T3 database compaction skips VACUUM while runs are active or free disk is under 2x DB size, and compacts freelist pages and WAL when idle', () => {
	const root = tempDir('t3-db-compact-test-');
	const dbPath = join(root, 'statev2.sqlite');
	const db = new Database(dbPath);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec(`
		CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
		CREATE TABLE blobs (id INTEGER PRIMARY KEY, data TEXT);
	`);
	db.query('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?)').run('t1', 'running');
	const insert = db.query('INSERT INTO blobs (data) VALUES (?)');
	const chunk = 'a'.repeat(4000);
	db.transaction(() => {
		for (let i = 0; i < 400; i++) insert.run(chunk);
	})();
	db.exec('DELETE FROM blobs WHERE id > 20;');
	db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
	db.close();

	const bloatedSize = statSync(dbPath).size;
	expect(bloatedSize).toBeGreaterThan(500_000);

	// Active run blocks compaction.
	compactT3Database({
		dbPath,
		minReclaimBytes: 100_000,
		minFreeFloorBytes: 0,
		freeSpace: () => bloatedSize * 10,
	});
	expect(statSync(dbPath).size).toBe(bloatedSize);

	// Mark runs completed so the DB is idle.
	const idleDb = new Database(dbPath);
	idleDb.exec("UPDATE orchestration_v2_projection_runs SET status = 'completed';");
	idleDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
	idleDb.close();

	// Low free disk (< 2x DB size) blocks VACUUM.
	compactT3Database({
		dbPath,
		minReclaimBytes: 100_000,
		minFreeFloorBytes: 0,
		freeSpace: () => bloatedSize * 1.5,
	});
	expect(statSync(dbPath).size).toBe(bloatedSize);

	// Dry run leaves DB unchanged.
	compactT3Database({
		dbPath,
		dryRun: true,
		minReclaimBytes: 100_000,
		minFreeFloorBytes: 0,
		freeSpace: () => bloatedSize * 10,
	});
	expect(statSync(dbPath).size).toBe(bloatedSize);

	// Idle + enough disk compacts freelist pages and truncates WAL.
	compactT3Database({
		dbPath,
		minReclaimBytes: 100_000,
		minFreeFloorBytes: 0,
		freeSpace: () => bloatedSize * 10,
	});
	expect(statSync(dbPath).size).toBeLessThan(bloatedSize / 2);
	const walPath = `${dbPath}-wal`;
	expect(existsSync(walPath) ? statSync(walPath).size : 0).toBe(0);
});
