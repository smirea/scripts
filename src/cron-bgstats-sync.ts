#!/usr/bin/env bun
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { format, isValid, parseISO, subDays } from 'date-fns';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { failWithFullHelp } from './utils/yargs';

const SOURCE_NAME = 'clocktracker.app';
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_SYNC_TIMEOUT_SECONDS = 60;
const CRONTAB_START = '# BEGIN cron-bgstats-sync';
const CRONTAB_END = '# END cron-bgstats-sync';

interface ClockTrackerPlay {
  sourceName: string;
  sourcePlayId: string;
  playDate: string;
}

interface BgStatsPlay {
  playDate?: string | null;
  metadata?: {
    bgstatsCli?: {
      sourceName?: string;
      sourcePlayId?: string;
    };
  } | null;
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('cron-bgstats-sync')
    .version(false)
    .usage('$0 <command> [options]')
    .parserConfiguration({
      'strip-aliased': true,
      'strip-dashed': true,
    })
    .command(
      'run',
      'Sync ClockTracker when it contains plays not yet stored in BG Stats.',
      command => command
        .option('lookback-days', {
          type: 'number',
          default: DEFAULT_LOOKBACK_DAYS,
          describe: 'Days before the latest synced play to include when checking for backdated entries.',
        })
        .option('database', {
          type: 'string',
          describe: 'Override the BG Stats database path.',
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Report new ClockTracker plays without changing BG Stats.',
        })
        .option('sync', {
          type: 'boolean',
          default: true,
          describe: 'Open, sync, and close BG Stats around a write.',
        })
        .option('sync-timeout', {
          type: 'number',
          default: DEFAULT_SYNC_TIMEOUT_SECONDS,
          describe: 'Seconds to wait for each BG Stats Cloud Sync.',
        }),
      argv => {
        assertPositiveInteger(argv.lookbackDays, '--lookback-days');
        assertPositiveInteger(argv.syncTimeout, '--sync-timeout');
        syncNewClockTrackerPlays({
          lookbackDays: argv.lookbackDays,
          databasePath: argv.database,
          dryRun: argv.dryRun,
          sync: argv.sync,
          syncTimeoutSeconds: argv.syncTimeout,
        });
      },
    )
    .command(
      'install',
      'Install the daily 3:00 AM crontab entry.',
      () => {},
      () => installCrontab(),
    )
    .strict()
    .strictCommands()
    .demandCommand(1, 'Choose run or install.')
    .recommendCommands()
    .wrap(process.stdout.columns || 100)
    .fail(failWithFullHelp)
    .help()
    .parseAsync();
}

function syncNewClockTrackerPlays(options: {
  lookbackDays: number;
  databasePath?: string;
  dryRun: boolean;
  sync: boolean;
  syncTimeoutSeconds: number;
}): void {
  const storedPlays = readBgStatsPlays(options.databasePath);
  const since = clockTrackerSince(storedPlays, options.lookbackDays);
  const clockTrackerPlays = readClockTrackerPlays(since);
  const storedSourceIds = new Set(storedPlays.flatMap(play => {
    const source = play.metadata?.bgstatsCli;
    return source?.sourceName === SOURCE_NAME && source.sourcePlayId ? [source.sourcePlayId] : [];
  }));
  const newPlays = clockTrackerPlays.filter(play => !storedSourceIds.has(play.sourcePlayId));

  if (newPlays.length === 0) {
    process.stdout.write(`No new ClockTracker plays since ${since}.\n`);
    return;
  }

  process.stdout.write(`Found ${newPlays.length} new ClockTracker play${newPlays.length === 1 ? '' : 's'}.\n`);
  if (options.dryRun) {
    return;
  }
  const args = [
    '--no-env-file',
    path.join(import.meta.dir, 'bgstats.ts'),
    'sync',
    'plays',
    '-',
    '--sync-timeout',
    String(options.syncTimeoutSeconds),
  ];
  if (options.databasePath) {
    args.push('--database', options.databasePath);
  }
  if (!options.sync) {
    args.push('--no-sync');
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: JSON.stringify(clockTrackerPlays),
    maxBuffer: 10_000_000,
    timeout: options.syncTimeoutSeconds * 2_000 + 90_000,
  });
  assertCommandSucceeded(result, 'BG Stats sync');
  process.stdout.write(result.stdout);
}

function readBgStatsPlays(databasePath?: string): BgStatsPlay[] {
  const args = [
    '--no-env-file',
    path.join(import.meta.dir, 'bgstats.ts'),
    'read',
    'plays',
    '--format=json',
  ];
  if (databasePath) {
    args.push('--database', databasePath);
  }
  return runJsonArrayCommand<BgStatsPlay>(args, 'BG Stats');
}

function readClockTrackerPlays(since: string): ClockTrackerPlay[] {
  return runJsonArrayCommand<ClockTrackerPlay>([
    '--no-env-file',
    path.join(import.meta.dir, 'clocktracker.ts'),
    '--since',
    since,
    '--format=bgstats',
  ], 'ClockTracker', 120_000);
}

function runJsonArrayCommand<T>(args: string[], name: string, timeout = 60_000): T[] {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 10_000_000,
    timeout,
  });
  assertCommandSucceeded(result, name);
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(value)) {
      throw new Error('Expected an array.');
    }
    return value as T[];
  } catch (error) {
    throw new Error(`${name} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clockTrackerSince(plays: BgStatsPlay[], lookbackDays: number): string {
  const latestDate = plays.flatMap(play => {
    const source = play.metadata?.bgstatsCli;
    if (source?.sourceName !== SOURCE_NAME || !play.playDate) {
      return [];
    }
    const date = parseISO(play.playDate);
    return isValid(date) ? [date] : [];
  }).sort((left, right) => right.getTime() - left.getTime()).at(0) ?? new Date();
  return format(subDays(latestDate, lookbackDays), 'yyyy-MM-dd');
}

function installCrontab(): void {
  if (process.platform !== 'darwin') {
    throw new Error('BG Stats syncing requires macOS.');
  }
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  const logDirectory = path.join(home, 'Library', 'Logs');
  mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, 'cron-bgstats-sync.log');
  const command = `cd ${shellQuote(path.resolve(import.meta.dir, '..'))} && ${shellQuote(process.execPath)} --no-env-file ${shellQuote(import.meta.path)} run >> ${shellQuote(logPath)} 2>&1`;
  const current = readCrontab();
  const retainedLines: string[] = [];
  let insideManagedEntry = false;
  for (const line of current.split('\n')) {
    if (line === CRONTAB_START) {
      insideManagedEntry = true;
      continue;
    }
    if (line === CRONTAB_END) {
      insideManagedEntry = false;
      continue;
    }
    if (!insideManagedEntry) {
      retainedLines.push(line);
    }
  }
  const retained = retainedLines.join('\n').trimEnd();
  const updated = `${retained}${retained ? '\n\n' : ''}${CRONTAB_START}\n0 3 * * * ${command}\n${CRONTAB_END}\n`;
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'cron-bgstats-sync-'));
  const temporaryCrontab = path.join(temporaryDirectory, 'crontab');
  try {
    writeFileSync(temporaryCrontab, updated, { mode: 0o600 });
    const result = spawnSync('crontab', [temporaryCrontab], { encoding: 'utf8', timeout: 120_000 });
    assertCommandSucceeded(result, 'crontab install');
  } finally {
    unlinkSync(temporaryCrontab);
    rmdirSync(temporaryDirectory);
  }
  process.stdout.write(`Installed daily 3:00 AM sync in crontab. Logs: ${logPath}\n`);
}

function readCrontab(): string {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return result.stdout;
  }
  if (/no crontab for/iu.test(result.stderr)) {
    return '';
  }
  throw new Error(result.stderr.trim() || `crontab failed with exit code ${result.status ?? 'unknown'}.`);
}

function assertCommandSucceeded(result: SpawnSyncReturns<string>, name: string): void {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${name} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
