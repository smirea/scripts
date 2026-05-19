#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createScript } from '../utils/createScript';
import { defaultLogCommand, logCommand } from './commands/log';
import { mealPlanCommand } from './commands/mealplan';

if (import.meta.main) {
  await createScript(runCliWithErrorFormatting);
}

async function runCliWithErrorFormatting(): Promise<void> {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('era-fit')
    .version(false)
    .strict()
    .command(defaultLogCommand)
    .command(logCommand)
    .command(mealPlanCommand)
    .help()
    .parseAsync();
}
