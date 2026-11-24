import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import { allocated, freeBytes, human } from '../utils/disk';
import { gitEnvironment } from '../utils/worktreeCache';

export { allocated, freeBytes, human };

export const STATE_DIR = path.join(homedir(), '.local/state/cron');
export const LOG_FILE = path.join(homedir(), 'Library/Logs/cron.log');

/** An action logs as it goes or returns its report; either way a later failure in the step keeps what came before. */
export type Step = { name: string; action: (dryRun: boolean) => string[] | void };

/** Runs every step even when one fails, so one broken tool never blocks the rest; returns the names that failed. */
export function runSteps(title: string, steps: Step[], dryRun: boolean) {
	console.log(`\n# ${new Date().toISOString()} ${title}${dryRun ? ' (dry run)' : ''}`);
	const failed: string[] = [];
	for (const step of steps) {
		console.log(`\n## ${step.name}`);
		try {
			for (const line of step.action(dryRun) ?? []) console.log(line);
		} catch (error) {
			failed.push(step.name);
			console.error(`FAILED: ${(error as Error).message}`);
		}
	}
	return failed;
}

const COMMAND_TIMEOUT_MS = 20 * 60_000;

/**
 * Runs an update command, or with `dryRun` only names it, and logs the command with the end of its output.
 * The timeout keeps a command that waits for input (a password, a license prompt) from stalling the whole run.
 */
export function exec(cmd: string[], dryRun: boolean, env: Record<string, string> = {}) {
	if (dryRun) {
		console.log(`would run: ${cmd.join(' ')}`);
		return;
	}
	console.log(`$ ${cmd.join(' ')}`);
	const result = spawnSync(cmd[0]!, cmd.slice(1), {
		encoding: 'utf8',
		env: { ...gitEnvironment(), ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
	if (result.status !== 0)
		throw new Error(
			`\`${cmd.join(' ')}\` ${result.error ? `failed: ${result.error.message}` : `exited ${result.status ?? result.signal}`}\n${output.split('\n').slice(-20).join('\n')}`,
		);
	for (const line of output.split('\n').filter(Boolean).slice(-3)) console.log(`  ${line}`);
}
