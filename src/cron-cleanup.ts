#!/usr/bin/env bun
import { createScript } from './utils/createScript';

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { pruneAbandoned } from './utils/agentWorktree';
import { run } from './utils/shell';
import { gc as simulatorGc } from './utils/simulators';

const home = homedir();
const LABEL = 'com.stefan.cron-cleanup';
const PLIST = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG_FILE = path.join(home, 'Library/Logs/cron-cleanup.log');
const STAMP = path.join(home, '.local/state/cron-cleanup/last-run');
const TRASH = path.join(home, '.Trash');
const TCC_DATABASE = path.join(home, 'Library/Application Support/com.apple.TCC/TCC.db');
const CONTAINER_ROOT = path.join(home, 'Library/Application Support/com.apple.container/containers');
const CONTAINER_LOGS = path.join(home, 'Library/Logs/repo-containers');
const PACKAGE_STAMP = path.join(home, '.local/state/cron-cleanup/last-package-prune');
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const BOOT_DELAY_MS = 10 * 60_000;
const SCHEDULE_WINDOW_MIN = 30;
const LOG_LIMIT = 20 * 1024 * 1024;
const LOG_KEEP = 2 * 1024 * 1024;
const BLOATED_CONTAINER = 4 * 1024 * 1024 * 1024;

type Step = { name: string; action: (dryRun: boolean) => string[] };

const STEPS: Step[] = [
	{ name: 't3 worktrees', action: dryRun => [...pruneAbandoned({ dryRun }), ...simulatorGc({ dryRun })] },
	{ name: 'repo containers', action: containers },
	{ name: 'logs', action: dryRun => [...trimLogs(CONTAINER_LOGS, dryRun), ...trimLog(LOG_FILE, dryRun)] },
	{ name: 'trash', action: emptyTrash },
	{ name: 'package caches (weekly)', action: packageCaches },
];

await createScript('cron-cleanup')
	.usage(
		'$0 <command>\n\nDaily disk cleanup for this Mac: removes T3 worktrees no open thread uses (with their simulators), prunes and trims the home-mac repo containers, caps their logs, empties the Trash, and once a week prunes the pnpm store and clears the bun cache. `install` schedules it at 03:14, and 10 minutes after login when the last run is over 24 hours old.',
	)
	.command(
		'run',
		'Clean up now',
		y =>
			y
				.option('dry-run', { type: 'boolean', default: false, describe: 'print what would be removed' })
				.option('scheduled', {
					type: 'boolean',
					default: false,
					describe:
						'how launchd calls it: run now inside the --at window, otherwise wait 10 minutes and run only when the last run is over 24 hours old',
				})
				.option('at', { type: 'string', default: '03:14', describe: 'scheduled time, HH:MM', coerce: validTime }),
		async argv => {
			if (argv.scheduled && !(await dueNow(parseTime(argv.at)))) return;
			await cleanup(argv.dryRun);
		},
	)
	.command(
		'install',
		'Install the LaunchAgent',
		y =>
			y
				.option('at', { type: 'string', default: '03:14', describe: 'daily time, HH:MM', coerce: validTime })
				.option('dry-run', { type: 'boolean', default: false, describe: 'print the plist without installing it' }),
		argv => install(argv.at, argv.dryRun),
	)
	.command('status', 'Show the last run and the schedule', {}, () => {
		console.log(`last run: ${lastRun() ? new Date(lastRun()!).toLocaleString() : 'never'}`);
		console.log(`LaunchAgent: ${existsSync(PLIST) ? PLIST : 'not installed (run `cron-cleanup install`)'}`);
		console.log(`log: ${LOG_FILE}`);
	})
	.demandCommand(1)
	.parseAsync();

function validTime(value: string) {
	parseTime(value);
	return value;
}

function parseTime(value: string) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value);
	const [hour, minute] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
	if (!(hour < 24 && minute < 60)) throw new Error(`--at takes HH:MM, such as 03:14; got ${value}.`);
	return { hour, minute };
}

function lastRun(): number | undefined {
	return existsSync(STAMP) ? statSync(STAMP).mtimeMs : undefined;
}

// launchd starts the job at login (RunAtLoad), at the calendar time, and on wake for a calendar time it slept through.
async function dueNow(at: { hour: number; minute: number }): Promise<boolean> {
	const now = new Date();
	const sinceScheduled = (now.getHours() * 60 + now.getMinutes() - (at.hour * 60 + at.minute) + 1440) % 1440;
	if (sinceScheduled < SCHEDULE_WINDOW_MIN) return true;
	await Bun.sleep(BOOT_DELAY_MS);
	const last = lastRun();
	if (last && Date.now() - last < DAY_MS) {
		console.log(`${new Date().toISOString()} skipped: last run ${new Date(last).toISOString()} is under 24 hours old`);
		return false;
	}
	return true;
}

async function cleanup(dryRun: boolean) {
	const freeBefore = freeBytes();
	console.log(`${new Date().toISOString()} cleanup${dryRun ? ' (dry run)' : ''}, ${human(freeBefore)} free`);
	const failed: string[] = [];
	for (const step of STEPS) {
		console.log(`\n## ${step.name}`);
		try {
			for (const line of step.action(dryRun)) console.log(line);
		} catch (error) {
			failed.push(step.name);
			console.error(`FAILED: ${(error as Error).message}`);
		}
	}
	const freeAfter = freeBytes();
	console.log(`\n${human(freeAfter)} free (${human(freeAfter - freeBefore)} reclaimed)`);
	if (!dryRun) {
		mkdirSync(path.dirname(STAMP), { recursive: true });
		writeFileSync(STAMP, new Date().toISOString());
	}
	if (failed.length) throw new Error(`Failed steps: ${failed.join(', ')}. Their errors are above.`);
}

function containers(dryRun: boolean): string[] {
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
		if (!Bun.which(tool)) throw new Error(`\`${tool}\` is not on PATH; check the PATH in ${PLIST}.`);
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
	mkdirSync(path.dirname(PACKAGE_STAMP), { recursive: true });
	writeFileSync(PACKAGE_STAMP, new Date().toISOString());
	const after = allocated(store) + allocated(bunCache);
	return [
		`pruned the pnpm store, ${oldStores.length} old pnpm stores, and the bun cache: ${human(before)} → ${human(after)}`,
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

function install(at: string, dryRun: boolean) {
	const { hour, minute } = parseTime(at);
	const bun = Bun.which('bun');
	if (!bun) throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun.');
	const pathEnv = [
		path.dirname(bun),
		path.join(home, 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		'/usr/sbin',
		'/sbin',
	];
	const args = [bun, '--no-env-file', import.meta.path, 'run', '--scheduled', '--at', at];
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv.join(':')}</string>
  </dict>
</dict>
</plist>
`;
	if (dryRun) {
		process.stdout.write(`Would write ${PLIST}:\n${plist}`);
		return;
	}
	writeFileSync(PLIST, plist);
	const domain = `gui/${process.getuid!()}`;
	run(['launchctl', 'bootout', `${domain}/${LABEL}`], { allowFail: true });
	run(['launchctl', 'bootstrap', domain, PLIST]);
	console.log(`Installed ${PLIST}: daily at ${at}, and 10 minutes after login when the last run is over 24 hours old.`);
	console.log(`Logs: ${LOG_FILE}`);
}

function allocated(target: string): number {
	return Number(run(['du', '-sk', target], { allowFail: true }).split('\t')[0] || 0) * 1024;
}

function freeBytes(): number {
	return Number(run(['df', '-k', '/']).split('\n')[1]!.trim().split(/\s+/)[3]) * 1024;
}

function human(bytes: number) {
	const gb = bytes / 1024 ** 3;
	return Math.abs(gb) >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2) || 0} MB`;
}
