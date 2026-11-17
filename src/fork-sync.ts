#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.HOME;
if (!home) throw new Error('HOME is not set.');

const LOG_DIR = path.join(home, 'Library', 'Logs', 'fork-sync');
const LAUNCHD_LABEL = 'com.stefan.fork-sync';
const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const RUN_AT = { Hour: 12, Minute: 0 };

export interface Fork {
	name: string;
	dir: string;
	branch: string;
	/** Remote of the original project; `origin` is the fork. */
	upstream: string;
	/** Run in `dir` after the branch moves, to rebuild and reinstall. */
	install?: string[];
}

export const FORKS: Fork[] = [
	{
		name: 'tinybar',
		dir: path.join(home, 'code', 'tinybar'),
		branch: 'main',
		upstream: 'upstream',
		install: ['Scripts/install-fork.sh'],
	},
];

/**
 * `blocked` (dirty tree, wrong branch, rebase conflict, diverged from the fork's remote) needs a person and is the only
 * outcome that notifies. `failed` covers everything that can fix itself by the next run, like the network or a build.
 */
export type Outcome =
	| { kind: 'ok'; detail: string }
	| { kind: 'blocked'; detail: string }
	| { kind: 'failed'; detail: string };

// The last-installed commit, so a failed install is retried even when upstream hasn't moved.
const INSTALLED_KEY = 'fork-sync.installed';

export async function syncFork(fork: Fork, log: (line: string) => void, dryRun = false): Promise<Outcome> {
	const git = async (...args: string[]) => {
		const result = await exec(['git', '-C', fork.dir, ...args], 5 * 60_000);
		log(`$ git ${args.join(' ')} -> ${result.code}${result.output ? `\n${result.output}` : ''}`);
		return result;
	};
	const rev = async (ref: string) => (await git('rev-parse', '--verify', '--quiet', ref)).stdout;

	if (!existsSync(path.join(fork.dir, '.git')))
		return {
			kind: 'failed',
			detail: `${fork.dir} is not a git checkout; clone the fork there or fix FORKS in fork-sync.ts.`,
		};
	const gitDir = (await git('rev-parse', '--absolute-git-dir')).stdout;
	if (
		['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some(name => existsSync(path.join(gitDir, name)))
	) {
		return {
			kind: 'blocked',
			detail: `a rebase, merge or cherry-pick is in progress in ${fork.dir}; finish or abort it.`,
		};
	}
	const branch = (await git('branch', '--show-current')).stdout;
	if (branch !== fork.branch)
		return {
			kind: 'blocked',
			detail: `${fork.dir} is on "${branch || 'a detached HEAD'}", not ${fork.branch}; check out ${fork.branch}.`,
		};
	const status = await git('status', '--porcelain');
	if (status.code !== 0) return { kind: 'failed', detail: 'git status failed.' };
	if (status.stdout)
		return { kind: 'blocked', detail: `${fork.dir} has uncommitted changes; commit or stash them:\n${status.stdout}` };

	for (const remote of [fork.upstream, 'origin']) {
		if ((await git('fetch', '--prune', remote)).code !== 0)
			return { kind: 'failed', detail: `git fetch ${remote} failed.` };
	}
	const upstreamRef = `${fork.upstream}/${fork.branch}`;
	const originRef = `origin/${fork.branch}`;
	const isAncestor = async (a: string, b: string) => (await git('merge-base', '--is-ancestor', a, b)).code === 0;

	// Commits pushed to the fork from another checkout come first, so the force push below can't drop them.
	if ((await rev(originRef)) && !(await isAncestor(originRef, 'HEAD'))) {
		if (!(await isAncestor('HEAD', originRef)))
			return { kind: 'blocked', detail: `${fork.branch} and ${originRef} have diverged; reconcile them by hand.` };
		if (dryRun) log(`[dry-run] git merge --ff-only ${originRef}`);
		else if ((await git('merge', '--ff-only', originRef)).code !== 0)
			return { kind: 'failed', detail: `fast-forward to ${originRef} failed.` };
	}

	if (!(await isAncestor(upstreamRef, 'HEAD'))) {
		if (dryRun) log(`[dry-run] git rebase ${upstreamRef}`);
		else if ((await git('rebase', upstreamRef)).code !== 0) {
			const conflicts = (await git('diff', '--name-only', '--diff-filter=U')).stdout;
			await git('rebase', '--abort');
			return {
				kind: 'blocked',
				detail: `rebasing onto ${upstreamRef} conflicts${conflicts ? ` in:\n${conflicts}` : ''}\nRebase by hand in ${fork.dir}.`,
			};
		}
	}

	const head = await rev('HEAD');
	if (head !== (await rev(originRef))) {
		if (dryRun) log(`[dry-run] git push --force-with-lease origin ${fork.branch}`);
		else if ((await git('push', '--force-with-lease', 'origin', fork.branch)).code !== 0)
			return { kind: 'failed', detail: `git push origin ${fork.branch} failed.` };
	}

	if (fork.install && (await git('config', '--get', INSTALLED_KEY)).stdout !== head) {
		if (dryRun) log(`[dry-run] ${fork.install.join(' ')}`);
		else {
			const result = await exec(fork.install, 30 * 60_000, fork.dir);
			log(`$ ${fork.install.join(' ')} -> ${result.code}\n${result.output}`);
			if (result.code !== 0) return { kind: 'failed', detail: `${fork.install.join(' ')} failed.` };
			await git('config', INSTALLED_KEY, head);
		}
	}
	return { kind: 'ok', detail: `${fork.branch} is at ${head.slice(0, 8)} on top of ${upstreamRef}.` };
}

if (import.meta.main) {
	void createScript('fork-sync')
		.usage(
			`$0 <command>\n\nKeeps forks of other people's projects current: rebases each fork's branch onto its upstream, force-pushes it to origin, and runs its install step. Forks are listed in FORKS in ${import.meta.path}. Each run overwrites ${LOG_DIR}/<fork>.log. Only a run that needs a person (uncommitted changes, wrong branch, a conflict) shows a notification; network and build failures just retry next run.`,
		)
		.command(
			'run',
			'Sync every fork once.',
			command =>
				command
					.option('fork', { type: 'string', choices: FORKS.map(fork => fork.name), describe: 'Sync only this fork.' })
					.option('dry-run', {
						type: 'boolean',
						default: false,
						describe: 'Fetch and print the rebase, push and install it would do, without doing them.',
					}),
			argv => run(argv.fork, argv.dryRun),
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

async function run(only: string | undefined, dryRun: boolean): Promise<void> {
	mkdirSync(LOG_DIR, { recursive: true });
	let failures = 0;
	for (const fork of FORKS.filter(fork => !only || fork.name === only)) {
		const logFile = path.join(LOG_DIR, `${fork.name}.log`);
		writeFileSync(logFile, `${new Date().toISOString()} fork-sync ${fork.name}${dryRun ? ' (dry run)' : ''}\n`);
		const log = (line: string) => {
			appendFileSync(logFile, `${line}\n`);
			if (dryRun) console.log(line);
		};
		let outcome: Outcome;
		try {
			outcome = await syncFork(fork, log, dryRun);
		} catch (error) {
			outcome = { kind: 'failed', detail: error instanceof Error ? (error.stack ?? error.message) : String(error) };
		}
		log(`${outcome.kind}: ${outcome.detail}`);
		console.log(`${fork.name}: ${outcome.kind}: ${outcome.detail.split('\n')[0]}`);
		if (outcome.kind !== 'ok') failures++;
		if (outcome.kind === 'blocked' && !dryRun)
			await notify(`${fork.name} needs you`, `${outcome.detail.split('\n')[0]!.replace(/:$/, '.')} Log: ${logFile}`);
	}
	if (failures) process.exitCode = 1;
}

async function notify(title: string, message: string): Promise<void> {
	const quote = (text: string) => JSON.stringify(text);
	await exec([
		'osascript',
		'-e',
		`display notification ${quote(message)} with title "fork-sync" subtitle ${quote(title)} sound name "Basso"`,
	]);
}

async function install(dryRun: boolean): Promise<void> {
	const bun = Bun.which('bun');
	if (!bun)
		throw new Error('`bun` is not on PATH; install it (curl -fsSL https://bun.sh/install | bash) and rerun install.');
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
    <string>${path.dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
	// bootout returns before the old job is gone, and bootstrapping over it fails with "5: Input/output error".
	for (let i = 0; i < 50 && (await exec(['launchctl', 'print', `${domain}/${LAUNCHD_LABEL}`])).code === 0; i++)
		await Bun.sleep(200);
	const bootstrap = await exec(['launchctl', 'bootstrap', domain, PLIST]);
	if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${PLIST} failed:\n${bootstrap.output}`);
	console.log(
		`Installed ${PLIST}: syncs ${FORKS.map(fork => fork.name).join(', ')} daily at ${RUN_AT.Hour}:${String(RUN_AT.Minute).padStart(2, '0')}. Logs: ${LOG_DIR}`,
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

async function exec(cmd: string[], timeoutMs = 60_000, cwd?: string) {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs,
		env: { ...process.env, GIT_EDITOR: 'true' },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') };
}
