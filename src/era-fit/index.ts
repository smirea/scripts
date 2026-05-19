#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createScript } from '../utils/createScript';
import { mealPlanCommand } from './commands/mealplan';
import { printFoodCommand } from './commands/print-food';
import { trackCommand } from './commands/track';

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
  const args = hideBin(process.argv);
  const parser = yargs(args)
    .scriptName('era-fit')
    .version(false)
    .strict()
    .strictCommands()
    .command(printFoodCommand)
    .command(mealPlanCommand)
    .command(trackCommand)
    .demandCommand(1, 'Choose an Era Fit command.')
    .help();

  if (args.length === 0) {
    parser.showHelp();
    return;
  }

  await parser.parseAsync();
}
