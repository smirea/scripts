#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { runBounded, ship } from './utils/prShip';
import {
	LOCAL_REVIEW_MODEL,
	localReviewStatus,
	markUnthreadedSeen,
	runLocalReview,
	startLocalReview,
	unthreadedSeen,
} from './utils/prShipReview';

await createScript('pr-ship')
	.usage(`$0 [--merge] [--once] [--budget seconds]

Drives the current branch's open PR to a verdict and exits with what to do next. Rerun it in the foreground until it exits 0.
A main T3 thread instead watches the PR with \`watch_pull_request\` and runs \`$0 --once --merge\` on each wake.
Delegated children can't watch a PR, so they loop it.
  0  ready, or merged with --merge
  1  something to fix: failing checks or unresolved review threads (printed)
  2  conflicts with the base branch: rebase onto it, push, rerun
  3  checks, Codex, or the local review still run (at once with --once, else when the budget is spent), or a slow \`gh\` call: rerun

When the review bot reports it can't review (Codex out of quota, another bot's usage or rate limit), pr-ship starts one
local review with \`agy\` (${LOCAL_REVIEW_MODEL}) in the background. It posts its findings as review threads and a
marker comment, and pr-ship then treats the PR as reviewed: resolve the threads, and it merges on green checks.`)
	.option('merge', {
		type: 'boolean',
		default: false,
		describe: 'merge once checks pass and Codex, or the local review standing in for it, has reviewed',
	})
	.option('once', {
		type: 'boolean',
		default: false,
		describe: 'answer the verdict now instead of waiting, for an agent whose PR watch does the waiting',
	})
	.option('budget', {
		type: 'number',
		default: 540,
		describe: 'seconds before it stops, under the 600s agent tool limit',
	})
	.check(argv => {
		if (!Number.isFinite(argv.budget) || argv.budget <= 0)
			throw new Error(`--budget must be a positive number of seconds, not ${argv.budget}`);
		return true;
	})
	.command(
		'$0',
		false,
		() => {},
		async argv => {
			const { code, message } = await ship(
				{
					now: Date.now,
					sleep: Bun.sleep,
					run: runBounded,
					log: console.log,
					localReview: {
						status: localReviewStatus,
						start: startLocalReview,
						unthreadedSeen,
						markUnthreadedSeen,
					},
				},
				{ merge: argv.merge, once: argv.once, budgetMs: argv.budget * 1000 },
			);
			// The last line names the code, so a `| tail` that swallows the exit status still shows it.
			console.log(`${message}\npr-ship exit ${code}`);
			process.exit(code);
		},
	)
	.command(
		'review',
		false,
		y =>
			y
				.option('repo', { type: 'string', demandOption: true, describe: 'owner/name' })
				.option('number', { type: 'number', demandOption: true })
				.option('base', { type: 'string', demandOption: true })
				.option('sha', { type: 'string', demandOption: true })
				.option('dry-run', { type: 'boolean', default: false, describe: 'print the findings instead of posting them' }),
		argv => {
			const [owner, repo] = argv.repo.split('/') as [string, string];
			runLocalReview({ owner, repo, number: argv.number, base: argv.base, sha: argv.sha }, { dryRun: argv.dryRun });
		},
	)
	.parseAsync();
