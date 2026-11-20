#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { SCRIPT_COMMANDS, type ScriptCommand } from './scriptCommands';

export const START_MARKER = '<!-- scripts-fyi:start -->';
export const END_MARKER = '<!-- scripts-fyi:end -->';

const DEFAULT_TARGET = path.join(homedir(), 'code', 'ai-files', 'GLOBAL_AGENTS.md');

interface CanonicalEntry {
	names: string[];
	source: string;
	description: string | null;
}

export function renderScriptsFyi(commands: readonly ScriptCommand[] = SCRIPT_COMMANDS): string {
	const entries: CanonicalEntry[] = [];
	const byName = new Map<string, CanonicalEntry>();

	for (const command of commands) {
		if ('aliasOf' in command) continue;
		if (command.description !== null) {
			const trimmed = command.description.trim();
			if (!trimmed || trimmed.includes('\n')) {
				throw new Error(
					`Script "${command.name}" in src/scriptCommands.ts must have a single-line description or null.`,
				);
			}
		}
		if (byName.has(command.name)) {
			throw new Error(`Duplicate script name "${command.name}" in src/scriptCommands.ts.`);
		}
		const entry: CanonicalEntry = {
			names: [command.name],
			source: command.source,
			description: command.description === null ? null : command.description.trim(),
		};
		entries.push(entry);
		byName.set(command.name, entry);
	}

	for (const command of commands) {
		if (!('aliasOf' in command)) continue;
		const canonical = byName.get(command.aliasOf);
		if (!canonical) {
			throw new Error(
				`Alias "${command.name}" references unknown canonical script "${command.aliasOf}" in src/scriptCommands.ts.`,
			);
		}
		if (canonical.source !== command.source) {
			throw new Error(
				`Alias "${command.name}" (${command.source}) must match source of "${command.aliasOf}" (${canonical.source}).`,
			);
		}
		canonical.names.push(command.name);
	}

	const lines = entries.map(entry => {
		const label = entry.names.map(name => `\`${name}\``).join(' / ');
		return entry.description ? `- ${label} [${entry.description}]` : `- ${label}`;
	});

	return [
		START_MARKER,
		'FYI: Personal CLI scripts live in `~/code/scripts` (on PATH in `~/bin`); run `<script> --help` or check `~/code/scripts` to investigate further. Available scripts (auto-updated from `smirea/scripts`):',
		...lines,
		END_MARKER,
	].join('\n');
}

export function updateGlobalAgentsContent(existing: string, section: string): string {
	const start = existing.indexOf(START_MARKER);
	const end = existing.indexOf(END_MARKER);

	if (start === -1 && end === -1) {
		const base = existing.trimEnd();
		return base ? `${base}\n\n${section}\n` : `${section}\n`;
	}

	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`Mismatched ${START_MARKER} / ${END_MARKER} markers in GLOBAL_AGENTS.md; fix or remove the broken marker and rerun.`,
		);
	}

	const afterEnd = end + END_MARKER.length;
	return `${existing.slice(0, start)}${section}${existing.slice(afterEnd)}`;
}

if (import.meta.main) {
	await createScript('sync-global-agents')
		.usage(
			'$0 [options]\n\nUpdates the auto-generated scripts FYI section in ai-files/GLOBAL_AGENTS.md from src/scriptCommands.ts.',
		)
		.command(
			'$0',
			'Sync the scripts FYI section into GLOBAL_AGENTS.md',
			command =>
				command
					.option('target', {
						type: 'string',
						default: DEFAULT_TARGET,
						describe: 'Path to GLOBAL_AGENTS.md to update',
					})
					.option('dry-run', {
						type: 'boolean',
						default: false,
						describe: 'Read the target and print what would change without writing',
					})
					.option('check', {
						type: 'boolean',
						default: false,
						describe: 'Exit 1 if the target is out of sync without writing',
					})
					.option('print', {
						type: 'boolean',
						default: false,
						describe: 'Print the rendered scripts FYI section to stdout without touching any file',
					}),
			argv => {
				const section = renderScriptsFyi();
				if (argv.print) {
					process.stdout.write(`${section}\n`);
					return;
				}
				if (!existsSync(argv.target)) {
					throw new Error(`Target file not found: ${argv.target}. Pass --target <path-to-GLOBAL_AGENTS.md>.`);
				}
				const existing = readFileSync(argv.target, 'utf8');
				const updated = updateGlobalAgentsContent(existing, section);
				const changed = updated !== existing;

				if (argv.check) {
					if (changed) {
						throw new Error(
							`${argv.target} is out of sync with src/scriptCommands.ts; run ./src/sync-global-agents.ts.`,
						);
					}
					console.log(`${argv.target} is up to date.`);
					return;
				}

				if (!changed) {
					console.log(`${argv.target} is already up to date.`);
					return;
				}

				if (argv.dryRun) {
					console.log(`[dry-run] Would update ${argv.target} with:\n\n${section}`);
					return;
				}

				writeFileSync(argv.target, updated, 'utf8');
				console.log(`Updated ${argv.target}.`);
			},
		)
		.parseAsync();
}
