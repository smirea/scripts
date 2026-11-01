#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { check, gc, repositories, settle, setup, teardown } from './utils/agentWorktree';
import { checkout } from './utils/shell';
import { gc as simulatorGc, status as simulatorStatus } from './utils/simulators';

await createScript('agent-t3-worktree')
  .usage('$0 <command>\n\nThe lifecycle of agent worktrees. T3 Code creates them, names their branches, and runs `setup` and `settle`; this does the rest.')
  .command('setup', 'Install, assign ports, write offline env files, and run the repo\'s `worktree:setup` script', y => y
    .option('reset-data', { type: 'boolean', default: false, describe: 'delete the worktree\'s .data/ first' }), async argv => {
    console.log(await setup(process.cwd(), { resetData: argv.resetData }));
  })
  .command('check', 'Exit 1 when the worktree\'s setup is missing or stale', y => y
    .option('heal', { type: 'boolean', default: false, describe: 'run setup instead of failing' })
    .option('quiet', { type: 'boolean', default: false, describe: 'print nothing when the worktree is ready' }), async argv => {
    const problems = check(process.cwd());
    if (!problems.length) {
      if (!argv.quiet) console.log('Worktree setup is current.');
      return;
    }
    if (!argv.heal) throw new Error(`Worktree setup is incomplete: ${problems.join('; ')}. Run \`agent-t3-worktree setup\`.`);
    console.log(`Worktree setup was incomplete (${problems.join('; ')}), so it ran again.`);
    console.log(await setup(process.cwd()));
  })
  .command('settle', 'Stop the worktree\'s servers and simulators, drop its build caches, and gc its repository', y => y
    .option('dry-run', { type: 'boolean', default: false }), argv => {
    for (const line of settle(process.cwd(), { dryRun: argv.dryRun })) console.log(line);
  })
  .command('gc', 'Remove worktrees and branches whose PR merged, with their servers and simulators; then simulator gc', y => y
    .option('repo', { type: 'string', describe: 'only this repository (default: every repo in ~/code and T3\'s worktrees)' })
    .option('dry-run', { type: 'boolean', default: false }), argv => {
    const mains = argv.repo ? [checkout(argv.repo)?.main ?? argv.repo] : repositories();
    for (const line of [...gc(mains, { dryRun: argv.dryRun }), ...simulatorGc({ dryRun: argv.dryRun }), simulatorStatus()]) console.log(line);
  })
  .command('teardown <worktree>', 'Remove one worktree (path, branch, or directory name) once its PR merged', y => y
    .positional('worktree', { type: 'string', demandOption: true })
    .option('force', { type: 'boolean', default: false, describe: 'remove it even without a merged PR' }), argv => {
    console.log(teardown(process.cwd(), argv.worktree, { force: argv.force }));
  })
  .demandCommand(1)
  .parseAsync();
