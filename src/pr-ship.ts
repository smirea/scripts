#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { runBounded, ship } from './utils/prShip';

await createScript('pr-ship')
  .usage(`$0 [--merge] [--budget seconds]

Drives the current branch's open PR to a verdict and exits with what to do next. Rerun it in the foreground until it exits 0.
  0  ready, or merged with --merge
  1  something to fix: failing checks or unresolved review threads (printed)
  2  conflicts with the base branch: rebase onto it, push, rerun
  3  budget spent while checks or Codex still run, or during a slow \`gh\` call: rerun`)
  .option('merge', { type: 'boolean', default: false, describe: 'merge once checks pass and Codex has reviewed' })
  .option('budget', { type: 'number', default: 540, describe: 'seconds before it stops, under the 600s agent tool limit' })
  .check(argv => {
    if (!Number.isFinite(argv.budget) || argv.budget <= 0) throw new Error(`--budget must be a positive number of seconds, not ${argv.budget}`);
    return true;
  })
  .command('$0', false, () => {}, async argv => {
    const { code, message } = await ship(
      { now: Date.now, sleep: Bun.sleep, run: runBounded, log: console.log },
      { merge: argv.merge, budgetMs: argv.budget * 1000 },
    );
    // The last line names the code, so a `| tail` that swallows the exit status still shows it.
    console.log(`${message}\npr-ship exit ${code}`);
    process.exit(code);
  })
  .parseAsync();
