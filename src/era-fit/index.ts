#!/usr/bin/env bun
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createScript } from '../utils/createScript';
import { mealPlanCommand } from './commands/mealplan';
import { defaultPrintFoodCommand, printFoodCommand } from './commands/print-food';
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
  await yargs(hideBin(process.argv))
    .scriptName('era-fit')
    .version(false)
    .strict()
    .strictCommands()
    .command(defaultPrintFoodCommand)
    .command(printFoodCommand)
    .command(mealPlanCommand)
    .command(trackCommand)
    .help()
    .parseAsync();
}
