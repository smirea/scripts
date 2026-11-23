import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { run } from './shell';

export const LOCAL_REVIEW_MARKER = 'pr-ship-local-review:v1';
export const LOCAL_REVIEW_MODEL = 'gemini-4-neon-xhigh';
// A review of a large diff at XHigh takes 5 to 15 minutes; past this it is stuck.
const REVIEW_TIMEOUT_MS = 30 * 60_000;

export type ReviewTarget = { owner: string; repo: string; number: number; base: string; sha: string };
export type LocalReviewStatus = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; reason: string };
type Finding = { path: string; line: number; body: string };

const FINDINGS_SCHEMA = {
	type: 'object',
	properties: {
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: { path: { type: 'string' }, line: { type: 'integer' }, body: { type: 'string' } },
				required: ['path', 'line', 'body'],
			},
		},
	},
	required: ['findings'],
};

// Per worktree and per PR: one local review per PR, like the bot's first review, whatever is pushed while it runs.
function stateDir() {
	const dir = run(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'pr-ship']);
	mkdirSync(dir, { recursive: true });
	return dir;
}
const file = (pr: number, ext: string) => join(stateDir(), `review-${pr}.${ext}`);

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function localReviewStatus(pr: number): LocalReviewStatus {
	const pidFile = file(pr, 'pid');
	if (!existsSync(pidFile)) return { kind: 'idle' };
	if (alive(Number(readFileSync(pidFile, 'utf8')))) return { kind: 'running' };
	// A review that just posted shows on the next PR read. Past that, a missing marker (deleted, or a reopened PR) means
	// it should run again.
	const done = file(pr, 'done');
	if (existsSync(done) && Date.now() - statSync(done).mtimeMs < 2 * 60_000) return { kind: 'running' };
	if (existsSync(done)) {
		rmSync(done);
		rmSync(pidFile, { force: true });
		return { kind: 'idle' };
	}
	const log = existsSync(file(pr, 'log')) ? readFileSync(file(pr, 'log'), 'utf8') : '';
	rmSync(pidFile, { force: true });
	return { kind: 'failed', reason: `${log.trim().split('\n').slice(-15).join('\n')}\nFull log: ${file(pr, 'log')}` };
}

/** Starts `pr-ship review` detached, so it outlives pr-ship's budget and posts to the PR when it finishes. */
export function startLocalReview(target: ReviewTarget) {
	const log = openSync(file(target.number, 'log'), 'w');
	const child = spawn(
		process.execPath,
		[
			// The cwd is the PR's repo, whose .env could hold a GH_TOKEN that would post as someone else.
			'--no-env-file',
			join(import.meta.dir, '../pr-ship.ts'),
			'review',
			`--repo=${target.owner}/${target.repo}`,
			`--number=${target.number}`,
			`--base=${target.base}`,
			`--sha=${target.sha}`,
		],
		{ detached: true, stdio: ['ignore', log, log], cwd: run(['git', 'rev-parse', '--show-toplevel']) },
	);
	writeFileSync(file(target.number, 'pid'), String(child.pid));
	child.unref();
}

export const unthreadedSeen = (pr: number) => existsSync(file(pr, 'seen'));
export const markUnthreadedSeen = (pr: number) => writeFileSync(file(pr, 'seen'), '');

function review(target: ReviewTarget): Finding[] {
	run(['git', 'fetch', 'origin', target.base]);
	const diffFile = file(target.number, 'diff');
	writeFileSync(diffFile, run(['git', 'diff', `origin/${target.base}...${target.sha}`]));
	const schemaFile = file(target.number, 'schema.json');
	writeFileSync(schemaFile, JSON.stringify(FINDINGS_SCHEMA));
	const prompt = `You review pull request #${target.number} of ${target.owner}/${target.repo} because its review bot could not run. The working directory is the PR's checkout at ${target.sha}; its diff against origin/${target.base} is in ${diffFile}. Read AGENTS.md and the AGENTS.md or CLAUDE.md of each folder the diff touches, then the changed code with enough context to judge it.

Report only real problems the diff introduces: correctness bugs, data loss, security holes, broken contracts, and clear violations of the repo's written rules. Each must come with a concrete failure: what input or state, and what goes wrong. Skip style, naming, nits, speculation, and anything you could not confirm by reading the code. An empty list is the right answer for a correct PR.

For each finding give the file path relative to the repo root, a line number in the new version of the file (a changed line when the problem is in changed code), and a body that states the problem and the failure. Never edit, commit, or push anything.`;
	const result = spawnSync(
		'agy',
		[
			'--print',
			prompt,
			'--model',
			LOCAL_REVIEW_MODEL,
			'--sandbox',
			'--dangerously-skip-permissions',
			'--output-format',
			'json',
			'--json-schema',
			schemaFile,
		],
		{ encoding: 'utf8', timeout: REVIEW_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.error)
		throw new Error(`\`agy\` could not run: ${result.error.message}. Is the Antigravity CLI installed?`);
	if (result.status !== 0) throw new Error(`\`agy\` exited ${result.status}:\n${result.stderr}${result.stdout}`);
	const output = JSON.parse(result.stdout) as { status: string; structured_output?: { findings: Finding[] } };
	if (output.status !== 'SUCCESS' || !output.structured_output)
		throw new Error(`\`agy\` gave no review:\n${result.stdout.slice(0, 2000)}`);
	return output.structured_output.findings;
}

/** Reviews the PR and posts each finding as a review thread, then the marker comment pr-ship waits for. */
export function runLocalReview(target: ReviewTarget, { dryRun = false } = {}) {
	const findings = review(target);
	const api = `repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`;
	const unthreaded: Finding[] = [];
	for (const finding of findings) {
		const body = `${finding.body}\n\n_Local ${LOCAL_REVIEW_MODEL} review by pr-ship._`;
		const at = ['-f', `body=${body}`, '-f', `commit_id=${target.sha}`, '-f', `path=${finding.path}`];
		if (dryRun) {
			console.log(`Would post on ${finding.path}:${finding.line}: ${finding.body}`);
			continue;
		}
		// A line outside the diff's hunks is refused, so fall back to a comment on the whole file.
		const posted =
			spawnSync('gh', ['api', api, ...at, '-F', `line=${finding.line}`, '-f', 'side=RIGHT']).status === 0 ||
			spawnSync('gh', ['api', api, ...at, '-f', 'subject_type=file']).status === 0;
		if (!posted) unthreaded.push(finding);
	}
	const state = JSON.stringify({ sha: target.sha, findings: findings.length, unthreaded: unthreaded.length });
	const lines = [
		`Local review by pr-ship with ${LOCAL_REVIEW_MODEL}, because the review bot could not review this PR: ${findings.length ? `${findings.length} finding(s).` : 'no findings.'}`,
		...unthreaded.map(finding => `- ${finding.path}:${finding.line} ${finding.body}`),
		`<!-- ${LOCAL_REVIEW_MARKER} ${state} -->`,
	];
	if (dryRun) return console.log(lines.join('\n'));
	run([
		'gh',
		'pr',
		'comment',
		String(target.number),
		'--repo',
		`${target.owner}/${target.repo}`,
		'--body',
		lines.join('\n'),
	]);
	writeFileSync(file(target.number, 'done'), '');
	console.log(`Posted the local review of #${target.number}: ${findings.length} finding(s).`);
}
