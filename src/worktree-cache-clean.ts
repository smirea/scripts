#!/usr/bin/env bun
import { createScript } from './utils/createScript';
import { cleanWorktreeCache } from './utils/worktreeCache';

await createScript('worktree-cache-clean')
  .command('$0 [directory]', 'Remove ignored Xcode build caches from an idle linked worktree', y => y
    .positional('directory', { type: 'string', default: process.cwd() })
    .option('dry-run', { type: 'boolean', default: false, describe: 'Report without removing files' }), argv => {
    for (const message of cleanWorktreeCache(argv.directory, { dryRun: argv.dryRun })) console.log(message);
  })
  .parseAsync();
