import { afterEach, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, classify, reclaimDisk, setup, type Entry } from './agentWorktree';
import { git } from './shell';

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repoWithWorktree(env: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-worktree-test-')));
	temporary.push(dir);
	const main = join(dir, 'main');
	mkdirSync(main);
	git(main, 'init', '-q');
	writeFileSync(join(main, '.env'), env);
	writeFileSync(join(main, '.gitignore'), '.env.override\n.env.local\n');
	git(main, 'add', '.');
	git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
	// Under `.claude/worktrees`, so it counts as an agent worktree.
	const worktree = join(dir, 'repo/.claude/worktrees/feature');
	git(main, 'worktree', 'add', '-qb', 'feature', worktree);
	return { dir, main, worktree };
}

test('without env-manager targets, setup writes each port key and localhost URL into .env.local at the same offset in a free block', async () => {
	const { main, worktree } = repoWithWorktree(
		'UI_URL=http://app.localhost # {url}\nSERVER_URL=http://127.0.0.1:31091/api # {url}\nUI_PORT=31090 # {int}\nPORT=31091 # {int}\n',
	);
	expect(check(worktree)).toEqual(['setup has not run in this worktree']);

	await setup(worktree);
	expect(readFileSync(join(worktree, '.env.local'), 'utf8')).toBe(
		'UI_PORT=41090\nPORT=41091\nSERVER_URL=http://127.0.0.1:41091/api\n',
	);
	expect(check(worktree)).toEqual([]);
	expect(check(main)).toEqual([]);

	unlinkSync(join(worktree, '.env.local'));
	expect(check(worktree)).toEqual(['.env.local is missing']);
	await setup(worktree);
	expect(existsSync(join(worktree, '.env.local'))).toBe(true);
	expect(check(worktree)).toEqual([]);
});

test("with env-manager targets, setup writes the ports to .env.override, keeping other worktrees' blocks", async () => {
	const { main, worktree } = repoWithWorktree(
		'# env-manager: fixture\n# env-manager target: web format=ts path=.env.local\nCLIENT_PORT=31000 # {int}\nAPI_PORT=31001 # {int}\nAPI_URL=http://127.0.0.1:31001 # {url}\n',
	);
	const other = join(main, '..', 'repo/.claude/worktrees/other');
	git(main, 'worktree', 'add', '-qb', 'other', other);
	writeFileSync(join(other, '.env.override'), 'CLIENT_PORT=41000\n');
	await setup(worktree).catch(() => undefined);
	expect(readFileSync(join(worktree, '.env.override'), 'utf8')).toBe(
		'CLIENT_PORT=42000\nAPI_PORT=42001\nAPI_URL=http://127.0.0.1:42001\n',
	);
});

test('check leaves a hand-made worktree that setup never ran in alone', () => {
	const { dir, main } = repoWithWorktree('CLIENT_PORT=6000\n');
	const manual = join(dir, 'manual');
	git(main, 'worktree', 'add', '-qb', 'manual', manual);
	expect(check(manual)).toEqual([]);
});

test('setup in the main checkout changes nothing', async () => {
	const { main } = repoWithWorktree('CLIENT_PORT=6000\n');
	expect(await setup(main)).toBe('Main checkout: nothing to set up.');
	expect(existsSync(join(main, '.env.override'))).toBe(false);
});

const entry: Entry = { path: '/w', head: 'abc', branch: 'feature', locked: false, prunable: false, main: false };
const facts = {
	exists: true,
	agent: true,
	dirty: false,
	busy: false,
	running: false,
	open: false,
	prsKnown: true,
	landed: false,
	fresh: false,
};
const pr = {
	number: 7,
	headRefName: 'feature',
	headRefOid: 'abc',
	baseRefName: 'master',
	url: 'https://github.com/o/r/pull/7',
};

test('gc removes a worktree only when a merged PR or the default branch holds its commits and nothing uses it', () => {
	expect(classify(entry, { ...facts, pr })).toEqual({
		remove: true,
		pr,
		why: 'merged in https://github.com/o/r/pull/7',
	});
	expect(classify(entry, facts)).toEqual({ remove: false, why: 'no merged PR holds feature' });
	expect(classify(entry, { ...facts, landed: true })).toEqual({
		remove: true,
		why: 'the default branch holds every commit',
	});
	expect(classify(entry, { ...facts, landed: true, fresh: true })).toEqual({
		remove: false,
		why: 'no merged PR holds feature',
	});
	expect(classify(entry, { ...facts, landed: true, open: true })).toEqual({
		remove: false,
		why: 'a T3 thread on it is still open',
	});
	expect(classify(entry, { ...facts, pr, dirty: true })).toEqual({
		remove: false,
		why: 'uncommitted or untracked files',
	});
	expect(classify(entry, { ...facts, pr, busy: true })).toEqual({ remove: false, why: 'a process is running in it' });
	expect(classify(entry, { ...facts, pr, running: true })).toEqual({ remove: false, why: 'a T3 run is active in it' });
	expect(classify(entry, { ...facts, pr, open: true })).toEqual({
		remove: false,
		why: 'a T3 thread on it is still open',
	});
	expect(classify(entry, { ...facts, pr, agent: false })).toEqual({ remove: false, why: 'not an agent worktree' });
	expect(classify(entry, { ...facts, prsKnown: false })).toEqual({ remove: false, why: 'gh could not list PRs' });
	expect(classify({ ...entry, locked: true }, { ...facts, pr })).toEqual({ remove: false, why: 'locked' });
	expect(classify({ ...entry, prunable: true }, { ...facts, exists: false })).toEqual({
		remove: true,
		why: 'its directory is gone',
	});
});

test('reclaimDisk skips all stages at or above the watermark and stops once free space recovers', () => {
	const ran: string[] = [];
	const gb = 1024 ** 3;
	reclaimDisk({
		minFreeGb: 25,
		freeSpace: () => 25 * gb,
		stages: [{ name: 'first', run: () => (ran.push('first'), []) }],
	});
	expect(ran).toEqual([]);

	let free = 12 * gb;
	reclaimDisk({
		minFreeGb: 25,
		freeSpace: () => free,
		stages: [
			{
				name: 'first',
				run: () => {
					ran.push('first');
					free = 26 * gb;
					return ['freed 14 GB'];
				},
			},
			{
				name: 'second',
				run: () => {
					ran.push('second');
					return [];
				},
			},
		],
	});
	expect(ran).toEqual(['first']);
});
