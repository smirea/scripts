import type { CommandModule } from 'yargs';

import { addLogOptions, type LogCliArgs, runLogCommand } from '../core';

export const defaultLogCommand = {
  command: '$0',
  describe: 'Print daily macro log',
  builder: addLogOptions,
  handler: runLogCommand,
} satisfies CommandModule<{}, LogCliArgs>;

export const logCommand = {
  command: 'log',
  describe: 'Print daily macro log',
  builder: addLogOptions,
  handler: runLogCommand,
} satisfies CommandModule<{}, LogCliArgs>;
