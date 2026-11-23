import { spawnSync } from 'node:child_process';

import { LOCAL_REVIEW_MARKER, type LocalReviewStatus, type ReviewTarget } from './prShipReview';

const POLL_MS = 20_000;
const EXIT_RESERVE_MS = 2_000;

type Check = {
	__typename: string;
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string;
	state?: string;
	detailsUrl?: string;
	targetUrl?: string;
};
export type Pr = {
	number: number;
	url: string;
	state: string;
	headRefOid: string;
	baseRefName: string;
	mergeable: string;
	statusCheckRollup: Check[];
	comments: { body: string }[];
};

/** The local review pr-ship runs when the review bot can't; `prShipReview.ts` is the real one. */
export type LocalReview = {
	status(pr: number): LocalReviewStatus;
	start(target: ReviewTarget): void;
	unthreadedSeen(pr: number): boolean;
	markUnthreadedSeen(pr: number): void;
};

export type Io = {
	now(): number;
	sleep(ms: number): Promise<void>;
	run(cmd: string[], options?: { timeoutMs?: number }): string;
	log(line: string): void;
	localReview: LocalReview;
};
export type Verdict = { code: 0 | 1 | 2 | 3; message: string };

export class TimeoutError extends Error {}

/** Runs a command and answers its trimmed stdout, killing it after `timeoutMs` with a `TimeoutError`. */
export function runBounded(cmd: string[], { timeoutMs }: { timeoutMs?: number } = {}): string {
	const result = spawnSync(cmd[0]!, cmd.slice(1), {
		encoding: 'utf8',
		timeout: timeoutMs,
		killSignal: 'SIGKILL',
		maxBuffer: 64 * 1024 * 1024,
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
		throw new TimeoutError(`\`${cmd.join(' ')}\` ran past ${timeoutMs}ms`);
	if (result.status !== 0) throw new Error(`\`${cmd.join(' ')}\` failed\n${result.stderr ?? ''}${result.stdout ?? ''}`);
	return (result.stdout ?? '').trim();
}

class Exit extends Error {
	constructor(readonly verdict: Verdict) {
		super(verdict.message);
	}
}
function exit(code: Verdict['code'], message: string): never {
	throw new Exit({ code, message });
}

function checks(pr: Pr) {
	const all = pr.statusCheckRollup.map(check => ({
		name: check.name ?? check.context ?? '?',
		done: check.__typename === 'StatusContext' ? check.state !== 'PENDING' : check.status === 'COMPLETED',
		ok: ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? check.state ?? ''),
		url: check.detailsUrl ?? check.targetUrl ?? '',
	}));
	return { all, failed: all.filter(check => check.done && !check.ok), pending: all.filter(check => !check.done) };
}

// A bot that can't review says so in a comment about a review: Codex's quota message, or another bot's usage or rate
// limit. Requiring the review context keeps a deploy bot's rate limit from counting.
const BOT_FAILURE =
	/(usage limits?|quota|credits|rate limit)[\s\S]*\breviews?\b|\breviews?\b[\s\S]*(usage limits?|quota|credits|rate limit)|unable to review|\breview (failed|errored)/i;
// Only a comment that is the retry command counts, not a bot's hint that quotes it.
const RETRY = /^\s*@\S+ review\b/i;

const localReviewState = (pr: Pr) =>
	pr.comments
		.findLast(comment => comment.body.includes(LOCAL_REVIEW_MARKER))
		?.body.match(new RegExp(`${LOCAL_REVIEW_MARKER} (\\{.*?\\}) -->`))?.[1];

/**
 * `failed` once the review bot reports it can't review and nobody asked it to retry since; pr-ship's own local review
 * then stands in for it. The Codex summary's has_unresolved_findings never clears after the threads resolve, so
 * findings come from the threads.
 */
function botReview(pr: Pr): 'running' | 'completed' | 'failed' {
	if (localReviewState(pr)) return 'completed';
	const retried = (index: number) => pr.comments.findLastIndex(comment => RETRY.test(comment.body)) > index;
	const summary = pr.comments.findLastIndex(comment => comment.body.includes('codex-review-state:v1'));
	const state = pr.comments[summary]?.body.match(/codex-review-state:v1 (\{.*?\}) -->/)?.[1];
	const status = state && (JSON.parse(state).code_review as { status: string | null }).status;
	if (status === 'completed') return 'completed';
	if (status === 'failed' && !retried(summary)) return 'failed';
	const failure = pr.comments.findLastIndex(comment => !RETRY.test(comment.body) && BOT_FAILURE.test(comment.body));
	return failure >= 0 && !retried(failure) ? 'failed' : 'running';
}

/**
 * Drives the current branch's open PR to a verdict. Waits for CI and for Codex's first review; Codex reviews every PR
 * on its own when it opens, so after the first review it never waits for another. When the review bot can't review, it
 * starts one local review instead, whose findings land as review threads like the bot's. The budget is a hard stop: every
 * command is killed when it would outlive it. With `once` it never waits: an agent whose T3 PR watch does the waiting
 * runs it on each wake.
 */
export async function ship(
	io: Io,
	{ merge, budgetMs, once = false }: { merge: boolean; budgetMs: number; once?: boolean },
): Promise<Verdict> {
	const deadline = io.now() + budgetMs;
	function bounded(cmd: string[]): string {
		const timeoutMs = deadline - EXIT_RESERVE_MS - io.now();
		const name = `\`${cmd.slice(0, 3).join(' ')}\``;
		if (timeoutMs <= 0) exit(3, `The budget ran out before ${name}. Rerun.`);
		try {
			return io.run(cmd, { timeoutMs });
		} catch (error) {
			if (error instanceof TimeoutError) exit(3, `The budget ran out during ${name}. Rerun.`);
			throw error;
		}
	}
	const gh = (args: string[]) => bounded(['gh', ...args]);

	function view(): Pr {
		try {
			return JSON.parse(
				gh(['pr', 'view', '--json', 'number,url,state,headRefOid,baseRefName,mergeable,statusCheckRollup,comments']),
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes('no pull requests found'))
				exit(1, 'This branch has no PR. Push it and open one with `gh pr create`, then rerun.');
			throw error;
		}
	}

	function unresolvedThreads(owner: string, repo: string, number: number) {
		const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line comments(first:1){nodes{author{login} body url}}}}}}}`;
		const data = JSON.parse(
			gh([
				'api',
				'graphql',
				'-f',
				`query=${query}`,
				'-F',
				`owner=${owner}`,
				'-F',
				`repo=${repo}`,
				'-F',
				`number=${number}`,
			]),
		);
		type Thread = {
			isResolved: boolean;
			path: string;
			line: number | null;
			comments: { nodes: { author: { login: string }; body: string; url: string }[] };
		};
		return (data.data.repository.pullRequest.reviewThreads.nodes as Thread[])
			.filter(thread => !thread.isResolved)
			.map(thread => {
				const comment = thread.comments.nodes[0]!;
				return `- ${thread.path}:${thread.line ?? '?'} (${comment.author.login}) ${comment.body.split('\n')[0]!.slice(0, 200)}\n  ${comment.url}`;
			});
	}

	try {
		const head = bounded(['git', 'rev-parse', 'HEAD']);
		const [owner, repo] = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).split('/') as [
			string,
			string,
		];
		while (true) {
			const pr = view();
			if (pr.state === 'MERGED') exit(0, `Merged: ${pr.url}`);
			if (pr.state === 'CLOSED') exit(1, `${pr.url} is closed.`);
			if (pr.headRefOid !== head)
				exit(1, `The PR head is ${pr.headRefOid.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. Push, then rerun.`);
			if (pr.mergeable === 'CONFLICTING')
				exit(
					2,
					`${pr.url} conflicts with ${pr.baseRefName}, so CI will not run. Rebase onto origin/${pr.baseRefName}, push, rerun.`,
				);

			const { all, failed, pending } = checks(pr);
			if (failed.length)
				exit(
					1,
					`Failing checks:\n${failed.map(check => `- ${check.name} ${check.url}`).join('\n')}\nRead logs with \`gh run view <run id> --log-failed\`, fix the cause, push, rerun.`,
				);
			const threads = unresolvedThreads(owner, repo, pr.number);
			if (threads.length)
				exit(
					1,
					`Unresolved review threads:\n${threads.join('\n')}\nFix or answer each, resolve the thread, push, rerun.`,
				);

			const review = botReview(pr);
			if (review === 'failed') {
				const status = io.localReview.status(pr.number);
				if (status.kind === 'failed')
					exit(
						1,
						`The local review of ${pr.url} failed:\n${status.reason}\nFix the cause if it is in this repo, then rerun to start it again.`,
					);
				if (status.kind === 'idle') {
					io.localReview.start({ owner, repo, number: pr.number, base: pr.baseRefName, sha: head });
					io.log(`The review bot could not review ${pr.url}, so a local review runs; it posts to the PR when done.`);
				}
			}
			const local = localReviewState(pr);
			if (local) {
				const { unthreaded } = JSON.parse(local) as { unthreaded: number };
				if (unthreaded && !io.localReview.unthreadedSeen(pr.number)) {
					io.localReview.markUnthreadedSeen(pr.number);
					exit(
						1,
						`The local review has findings outside the diff's lines:\n${pr.comments.findLast(comment => comment.body.includes(LOCAL_REVIEW_MARKER))!.body}\nFix the real ones and push, then rerun.`,
					);
				}
			}
			const waiting = [
				...(all.length ? [] : ['checks to start']),
				...pending.map(check => check.name),
				...(review === 'running' ? ['Codex review'] : []),
				...(review === 'failed' ? ['the local review (5 to 15 minutes)'] : []),
			];
			if (!waiting.length && pr.mergeable === 'MERGEABLE') {
				if (!merge) exit(0, `Ready to merge: ${pr.url}`);
				gh(['pr', 'merge', String(pr.number), '--merge']);
				continue;
			}
			if (!waiting.length) waiting.push('GitHub to compute mergeability');
			if (once) exit(3, `Still waiting on ${waiting.join(', ')}. Rerun on the next PR watch wake.`);
			if (io.now() + POLL_MS > deadline) exit(3, `Still waiting on ${waiting.join(', ')}. Rerun.`);
			io.log(`Waiting on ${waiting.join(', ')}…`);
			await io.sleep(POLL_MS);
		}
	} catch (error) {
		if (error instanceof Exit) return error.verdict;
		throw error;
	}
}
