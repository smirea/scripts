#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

const LOG_DIR = path.join(home, 'Library', 'Logs', 'pstack-update');
const LAUNCHD_LABEL = 'com.stefan.pstack-update';
const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const RUN_AT = { Hour: 9, Minute: 0 };
const CODEX_CONFIG = path.join(home, '.codex', 'config.toml');

interface Harness {
	name: string;
	bin: string;
	steps: string[][];
	check?: () => string | undefined;
}

// Cursor isn't listed: it refreshes its pstack plugin every time an agent starts.
// Claude Code's own marketplace auto-update only runs on interactive CLI startup, never in T3/SDK sessions.
const HARNESSES: Harness[] = [
	{
		name: 'claude',
		bin: 'claude',
		steps: [
			['claude', 'plugin', 'marketplace', 'update', 't3-pstack'],
			['claude', 'plugin', 'update', 't3-pstack@t3-pstack'],
		],
	},
	{
		name: 'codex',
		bin: 'codex',
		steps: [['codex', 'plugin', 'marketplace', 'upgrade', 't3-pstack']],
		check: () => {
			if (!existsSync(CODEX_CONFIG)) return undefined;
			const section = readFileSync(CODEX_CONFIG, 'utf8').match(
				/^\[marketplaces\.t3-pstack\]\n((?:(?!\[).*\n?)*)/m,
			)?.[1];
			const ref = section?.match(/^ref\s*=\s*"([^"]+)"/m)?.[1];
			return ref
				? `${CODEX_CONFIG} pins [marketplaces.t3-pstack] to ref "${ref}", so upgrades never move past it. Delete that ref line.`
				: undefined;
		},
	},
];

if (import.meta.main) {
	void createScript('pstack-update')
		.usage(
			`$0 <command>\n\nUpdates the pstack plugin in every harness on this Mac (${HARNESSES.map(harness => harness.name).join(', ')}). Each run overwrites ${LOG_DIR}/last.log.`,
		)
		.command(
			'run',
			'Update pstack in every harness once.',
			command =>
				command.option('dry-run', {
					type: 'boolean',
					default: false,
					describe: 'Print the update commands without running them.',
				}),
			argv => run(argv.dryRun),
		)
		.command(
			'install',
			`Install a launchd agent that runs \`run\` daily at ${RUN_AT.Hour}:${String(RUN_AT.Minute).padStart(2, '0')}, or on wake if the Mac slept through it.`,
			command =>
				command.option('dry-run', {
					type: 'boolean',
					default: false,
					describe: 'Print the plist without installing it.',
				}),
			argv => install(argv.dryRun),
		)
		.command(
			'uninstall',
			'Remove the launchd agent.',
			command =>
				command.option('dry-run', { type: 'boolean', default: false, describe: 'Print what would be removed.' }),
			argv => uninstall(argv.dryRun),
		)
		.strictCommands()
		.demandCommand(1, 'Choose run, install, or uninstall.')
		.parseAsync();
}

async function run(dryRun: boolean): Promise<void> {
	const lines: string[] = [`pstack-update ${new Date().toISOString()}`];
	const log = (line: string) => {
		lines.push(line);
		console.log(line);
	};
	const failures: string[] = [];
	for (const harness of HARNESSES) {
		if (!Bun.which(harness.bin)) {
			log(`[${harness.name}] skipped: \`${harness.bin}\` is not on PATH`);
			continue;
		}
		const problem = harness.check?.();
		if (problem) {
			log(`[${harness.name}] ${problem}`);
			failures.push(harness.name);
		}
		for (const step of harness.steps) {
			if (dryRun) {
				log(`[${harness.name}] [dry-run] ${step.join(' ')}`);
				continue;
			}
			const result = await exec(step, 5 * 60_000);
			log(`[${harness.name}] $ ${step.join(' ')} -> ${result.code}${result.output ? `\n${result.output}` : ''}`);
			if (result.code !== 0) {
				failures.push(harness.name);
				break;
			}
		}
	}
	if (!dryRun) {
		mkdirSync(LOG_DIR, { recursive: true });
		writeFileSync(path.join(LOG_DIR, 'last.log'), `${lines.join('\n')}\n`);
	}
	if (failures.length) {
		const message = `pstack update failed for ${[...new Set(failures)].join(', ')}. See ${path.join(LOG_DIR, 'last.log')}.`;
		if (!dryRun && !process.stdout.isTTY)
			await exec(['osascript', '-e', `display notification ${JSON.stringify(message)} with title "pstack-update"`]);
		throw new Error(message);
	}
}

async function install(dryRun: boolean): Promise<void> {
	const bun = Bun.which('bun');
	if (!bun)
		throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun install.');
	const binDirs = [
		...new Set(
			HARNESSES.map(harness => Bun.which(harness.bin))
				.filter(Boolean)
				.map(bin => path.dirname(bin!)),
		),
	];
	const pathVar = [
		path.dirname(bun),
		...binDirs,
		path.join(home, 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
		'/bin',
		'/usr/sbin',
		'/sbin',
	];
	const args = [bun, '--no-env-file', import.meta.path, 'run'];
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${RUN_AT.Hour}</integer>
    <key>Minute</key>
    <integer>${RUN_AT.Minute}</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'launchd.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'launchd.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${[...new Set(pathVar)].join(':')}</string>
    <key>GIT_SSH_COMMAND</key>
    <string>ssh -o BatchMode=yes -o ConnectTimeout=20</string>
    <key>GIT_TERMINAL_PROMPT</key>
    <string>0</string>
  </dict>
</dict>
</plist>
`;
	if (dryRun) {
		process.stdout.write(`Would write ${PLIST}:\n${plist}`);
		return;
	}
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(PLIST, plist);
	const domain = `gui/${process.getuid!()}`;
	await exec(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]);
	for (let i = 0; i < 50 && (await exec(['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`])).code === 0; i++)
		await Bun.sleep(200);
	const bootstrap = await exec(['launchctl', 'bootstrap', domain, PLIST]);
	if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${PLIST} failed:\n${bootstrap.output}`);
	console.log(
		`Installed ${PLIST}: updates pstack daily at ${RUN_AT.Hour}:${String(RUN_AT.Minute).padStart(2, '0')}. Logs: ${LOG_DIR}`,
	);
}

async function uninstall(dryRun: boolean): Promise<void> {
	const domain = `gui/${process.getuid!()}`;
	if (dryRun) {
		console.log(`[dry-run] launchctl bootout ${domain}/${LAUNCHD_LABEL} and trash ${PLIST}`);
		return;
	}
	await exec(['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]);
	if (existsSync(PLIST)) await exec(['trash', PLIST]);
	console.log('Removed the launchd agent.');
}

async function exec(cmd: string[], timeoutMs = 60_000) {
	const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
}
