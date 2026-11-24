import { expect, test } from 'bun:test';

import { SCRIPT_COMMANDS } from './scriptCommands';
import { END_MARKER, renderScriptsFyi, START_MARKER, updateGlobalAgentsContent } from './sync-global-agents';

test('every registered script is listed with its aliases unless hidden from agents', () => {
	const rendered = renderScriptsFyi(SCRIPT_COMMANDS);
	const hidden = new Set(
		SCRIPT_COMMANDS.filter(command => 'hiddenFromAgents' in command && command.hiddenFromAgents).map(
			command => command.name,
		),
	);
	for (const command of SCRIPT_COMMANDS) {
		const canonical = 'aliasOf' in command ? command.aliasOf : command.name;
		if (hidden.has(canonical)) expect(rendered).not.toContain(`\`${command.name}\``);
		else expect(rendered).toContain(`\`${command.name}\``);
	}
});

test('updating GLOBAL_AGENTS replaces only the marked scripts block while keeping surrounding content intact', () => {
	const original = ['Before line 1', '', START_MARKER, 'old content', END_MARKER, '', 'After line 1', ''].join('\n');
	const nextSection = `${START_MARKER}\nnew content\n${END_MARKER}`;
	const updated = updateGlobalAgentsContent(original, nextSection);

	expect(updated).toBe(
		['Before line 1', '', START_MARKER, 'new content', END_MARKER, '', 'After line 1', ''].join('\n'),
	);
	expect(updateGlobalAgentsContent(updated, nextSection)).toBe(updated);
});

test('updating GLOBAL_AGENTS appends the marked block when absent and rejects mismatched markers', () => {
	const section = `${START_MARKER}\nbody\n${END_MARKER}`;
	expect(updateGlobalAgentsContent('Top rule\n\n', section)).toBe(`Top rule\n\n${section}\n`);
	expect(() => updateGlobalAgentsContent(`Top\n${START_MARKER}\nmissing end`, section)).toThrow(/Mismatched/);
	expect(() => updateGlobalAgentsContent(`${END_MARKER}\n${START_MARKER}`, section)).toThrow(/Mismatched/);
});
