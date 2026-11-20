#!/usr/bin/env bun
import { createScript } from './utils/createScript';

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { CLEANUP_STEPS } from './cron/cleanup';
import { freeBytes, human, LOG_FILE, runSteps, STATE_DIR } from './cron/steps';
import { UPDATE_STEPS } from './cron/update';
import { run } from './utils/shell';

const home = homedir();
const LABEL = 'com.stefan.cron';
const PLIST = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
const STAMP = path.join(STATE_DIR, 'last-run');
const DAY_MS = 24 * 60 * 60_000;
const BOOT_DELAY_MS = 10 * 60_000;
const SCHEDULE_WINDOW_MIN = 30;

const dryRunOption = { type: 'boolean', default: false, describe: 'print what it would do, change nothing' } as const;
const atOption = { type: 'string', default: '03:14', describe: 'daily time, HH:MM', coerce: validTime } as const;

await createScript('cron')
	.usage(
		"$0 <command>\n\nThis Mac's nightly maintenance. `cleanup` removes T3 worktrees no open thread uses (with their simulators), prunes the home-mac repo containers, caps logs, empties the Trash, and weekly prunes the pnpm and bun caches. `update` upgrades Homebrew, Tailscale, bun and its globals, npm and pnpm, the agent CLIs, the Codex app, uv tools, App Store apps, and the ai-files skills and plugins. `run` does both; `install` schedules it daily at 03:14, and 10 minutes after login when the last run is over 24 hours old.",
	)
	.command(
		'run',
		'Clean up, then update',
		y =>
			y
				.option('dry-run', dryRunOption)
				.option('scheduled', {
					type: 'boolean',
					default: false,
					describe:
						'how launchd calls it: run now inside the --at window, otherwise wait 10 minutes and run only when the last run is over 24 hours old',
				})
				.option('at', atOption),
		async argv => {
			if (argv.scheduled && !(await dueNow(parseTime(argv.at)))) return;
			finish([...cleanup(argv.dryRun), ...runSteps('update', UPDATE_STEPS, argv.dryRun)], argv.dryRun, true);
		},
	)
	.command(
		'cleanup',
		'Only clean up',
		y => y.option('dry-run', dryRunOption),
		argv => finish(cleanup(argv.dryRun), argv.dryRun, false),
	)
	.command(
		'update',
		'Only update',
		y => y.option('dry-run', dryRunOption),
		argv => finish(runSteps('update', UPDATE_STEPS, argv.dryRun), argv.dryRun, false),
	)
	.command(
		'install',
		'Install the LaunchAgent',
		y => y.option('at', atOption).option('dry-run', dryRunOption),
		argv => install(argv.at, argv.dryRun),
	)
	.command('status', 'Show the last run and the schedule', {}, () => {
		const last = lastRun();
		console.log(`last run: ${last ? new Date(last).toLocaleString() : 'never'}`);
		console.log(`LaunchAgent: ${existsSync(PLIST) ? PLIST : 'not installed (run `cron install`)'}`);
		console.log(`log: ${LOG_FILE}`);
	})
	.demandCommand(1)
	.parseAsync();

function cleanup(dryRun: boolean): string[] {
	const before = freeBytes();
	const failed = runSteps('cleanup', CLEANUP_STEPS, dryRun);
	const after = freeBytes();
	console.log(`\n${human(after)} free (${human(after - before)} reclaimed)`);
	return failed;
}

function finish(failed: string[], dryRun: boolean, stamp: boolean) {
	if (stamp && !dryRun) {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(STAMP, new Date().toISOString());
	}
	if (failed.length) throw new Error(`Failed steps: ${failed.join(', ')}. Their errors are above.`);
}

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

function install(at: string, dryRun: boolean) {
	const { hour, minute } = parseTime(at);
	// process.execPath can be bun's internal bun.exe, which leaves `bun` off PATH for the ~/bin wrappers the job runs.
	const bun = Bun.which('bun');
	if (!bun) throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun.');
	const pathEnv = [
		path.dirname(bun),
		path.join(home, 'bin'),
		path.join(home, '.local/bin'),
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
