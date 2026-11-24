import { expect, test } from 'bun:test';
import { type Io, nonInteractiveEnv, type Pr, ship, TimeoutError } from './prShip';
import { LOCAL_REVIEW_MARKER } from './prShipReview';

const HEAD = 'abc1234def';
const SUMMARY_DONE = '<!-- codex-review-state:v1 {"code_review":{"status":"completed"}} -->';

/**
 * A GitHub on a fake clock. `durations` maps a command prefix (`gh pr merge`) to how long it takes, so a test can
 * make any phase slow. Commands honor `timeoutMs` the way `run` does: they burn the timeout, then throw.
 */
function fakeGitHub({
	checksDoneAt = 0,
	codexDoneAt = 0,
	codexSummary = SUMMARY_DONE,
	durations = {},
	mergeable = 'MERGEABLE',
	localReviewTakes = 300_000,
}: {
	checksDoneAt?: number;
	codexDoneAt?: number;
	codexSummary?: string;
	durations?: Record<string, number>;
	mergeable?: string;
	localReviewTakes?: number;
} = {}) {
	const start = Date.parse('2026-10-31T12:00:00Z');
	let now = start;
	let state = 'OPEN';
	const calls: string[] = [];
	const elapsed = () => now - start;
	const localReviews: number[] = [];
	const localReviewPosted = () => localReviews.length > 0 && elapsed() >= localReviews[0]! + localReviewTakes;
	const pr = (): Pr => ({
		number: 7,
		url: 'https://github.com/smirea/procrastimate/pull/7',
		state,
		headRefOid: HEAD,
		baseRefName: 'main',
		mergeable,
		statusCheckRollup: [
			elapsed() >= checksDoneAt
				? { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }
				: { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' },
		],
		comments: [
			...(elapsed() >= codexDoneAt ? [{ body: codexSummary }] : []),
			...(localReviewPosted()
				? [{ body: `Local review <!-- ${LOCAL_REVIEW_MARKER} {"sha":"${HEAD}","findings":0,"unthreaded":0} -->` }]
				: []),
		],
	});
	const answer = (cmd: string): string => {
		if (cmd === 'git rev-parse HEAD') return HEAD;
		if (cmd.startsWith('gh repo view')) return 'smirea/procrastimate';
		if (cmd.startsWith('gh pr view')) return JSON.stringify(pr());
		if (cmd.startsWith('gh api graphql'))
			return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
		if (cmd.startsWith('gh pr merge')) {
			state = 'MERGED';
			return '';
		}
		throw new Error(`unexpected command: ${cmd}`);
	};
	const io: Io = {
		now: () => now,
		sleep: async ms => {
			now += ms;
		},
		run: (cmd, options = {}) => {
			const line = cmd.join(' ');
			calls.push(line);
			const duration = Object.entries(durations).find(([prefix]) => line.startsWith(prefix))?.[1] ?? 1000;
			if (options.timeoutMs !== undefined && duration > options.timeoutMs) {
				now += options.timeoutMs;
				throw new TimeoutError(`\`${line}\` ran past ${options.timeoutMs}ms`);
			}
			now += duration;
			return answer(line);
		},
		log: () => {},
		localReview: {
			status: () => (localReviews.length ? { kind: 'running' } : { kind: 'idle' }),
			start: () => localReviews.push(elapsed()),
			unthreadedSeen: () => false,
			markUnthreadedSeen: () => {},
		},
	};
	return { io, calls, elapsed, localReviews };
}

const BUDGET_MS = 500_000;
const merged = (calls: string[]) => calls.some(call => call.startsWith('gh pr merge'));

test('pr-ship exits 3 before its budget runs out however slow a phase is', async () => {
	for (const [durations, checksDoneAt] of [
		[{ 'gh pr merge': 120_000 }, 470_000],
		[{ 'gh pr view': 90_000 }, 480_000],
		[{ 'gh api graphql': 200_000 }, 300_000],
		[{ 'gh pr view': 900_000 }, 0],
	] as const) {
		const github = fakeGitHub({ checksDoneAt, durations });
		const verdict = await ship(github.io, { merge: true, budgetMs: BUDGET_MS });
		expect(github.elapsed()).toBeLessThanOrEqual(BUDGET_MS);
		expect(verdict.code).toBe(3);
	}
});

test('a green PR with a completed Codex review is merged and exits 0', async () => {
	const github = fakeGitHub({ checksDoneAt: 60_000 });
	expect((await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(0);
	expect(merged(github.calls)).toBe(true);
});

test('a pending Codex review is never merged past and exits 3', async () => {
	const github = fakeGitHub({ codexDoneAt: Infinity });
	expect((await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(3);
	expect(merged(github.calls)).toBe(false);
});

const FAILED_REVIEW =
	'You have reached your Codex usage limits for code reviews. <!-- codex-review-state:v1 {"code_review":{"status":"failed"}} -->';

test('a review bot that cannot review is replaced by one local review, and the PR merges only once it posted', async () => {
	for (const summary of [FAILED_REVIEW, 'Codex: You have reached your usage limits for code reviews.']) {
		const github = fakeGitHub({ codexSummary: summary });
		expect((await ship(github.io, { merge: true, budgetMs: 200_000 })).code).toBe(3);
		expect(merged(github.calls)).toBe(false);
		expect((await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(0);
		expect(merged(github.calls)).toBe(true);
		expect(github.localReviews).toHaveLength(1);
	}
});

test('a failure that is not about a review, or a bot hint quoting the retry command, never stands in for a retry', async () => {
	const deploy = fakeGitHub({ codexDoneAt: Infinity });
	const view = deploy.io.run;
	deploy.io.run = (cmd, options) => {
		const out = view(cmd, options);
		if (!cmd.join(' ').startsWith('gh pr view')) return out;
		const pr = JSON.parse(out) as Pr;
		return JSON.stringify({ ...pr, comments: [{ body: 'Deploy preview skipped: Cloudflare API rate limit.' }] });
	};
	expect((await ship(deploy.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(3);
	expect(deploy.localReviews).toHaveLength(0);

	const hint = fakeGitHub({ codexSummary: 'Review rate limit exceeded. Comment `@coderabbitai review` to retry.' });
	await ship(hint.io, { merge: true, budgetMs: BUDGET_MS });
	expect(hint.localReviews).toHaveLength(1);
});

test('a `@codex review` retry asked after the failure waits for Codex instead of reviewing locally', async () => {
	const retried = fakeGitHub({ codexSummary: FAILED_REVIEW });
	const view = retried.io.run;
	retried.io.run = (cmd, options) => {
		const out = view(cmd, options);
		if (!cmd.join(' ').startsWith('gh pr view')) return out;
		const pr = JSON.parse(out) as Pr;
		return JSON.stringify({ ...pr, comments: [...pr.comments, { body: '@codex review' }] });
	};
	expect((await ship(retried.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(3);
	expect(merged(retried.calls)).toBe(false);
	expect(retried.localReviews).toHaveLength(0);
});

test('a PR that conflicts with its base exits 2 without merging', async () => {
	const github = fakeGitHub({ mergeable: 'CONFLICTING' });
	expect((await ship(github.io, { merge: true, budgetMs: BUDGET_MS })).code).toBe(2);
	expect(merged(github.calls)).toBe(false);
});

test('nonInteractiveEnv strips forced color and TTY variables so gh JSON output never contains ANSI escapes', () => {
	const env = nonInteractiveEnv({
		PATH: '/usr/bin',
		CLICOLOR_FORCE: '1',
		GH_FORCE_TTY: '1',
		FORCE_COLOR: '1',
		GH_TOKEN: 'keep-me',
	});
	expect(env.CLICOLOR_FORCE).toBeUndefined();
	expect(env.GH_FORCE_TTY).toBeUndefined();
	expect(env.FORCE_COLOR).toBeUndefined();
	expect(env.NO_COLOR).toBe('1');
	expect(env.CLICOLOR).toBe('0');
	expect(env.GH_PAGER).toBe('');
	expect(env.GH_PROMPT_DISABLED).toBe('1');
	expect(env.GH_TOKEN).toBe('keep-me');
});
