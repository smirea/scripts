#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { z } from 'zod';

import { failWithFullHelp } from './utils/yargs';

const READ_ENTITIES = ['games', 'plays', 'players'] as const;
const OUTPUT_FORMATS = ['json', 'table'] as const;
const APPLE_REFERENCE_DATE_UNIX_SECONDS = 978_307_200;
const DEFAULT_SOURCE_NAME = 'bgstats-cli';
const BG_STATS_BUNDLE_ID = 'nl.vissering.BoardGameStats';
const BG_STATS_APP_NAME = 'BG Stats';
const DEFAULT_SYNC_TIMEOUT_SECONDS = 60;
const RECENT_SYNC_MAX_AGE_MS = 10 * 60 * 1000;
const CLOUD_SYNC_COOLDOWN_MS = 65_000;

type ReadEntity = (typeof READ_ENTITIES)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

interface GameRow {
  uuid: string | null;
  name: string | null;
  bggId: number | null;
  bggName: string | null;
  bggYear: number | null;
  cooperative: number;
  highestScoreWins: number;
  noPoints: number;
  usesTeams: number;
  minPlayers: number;
  maxPlayers: number;
  minPlaytime: number;
  maxPlaytime: number;
  isBaseGame: number;
  isExpansion: number;
  rating: number;
  tags: string | null;
  metadata: string | null;
  modificationDate: number | null;
  lastCloudSync: number | null;
  playCount: number;
}

interface PlayerRow {
  uuid: string | null;
  name: string | null;
  bggUsername: string | null;
  isMe: number;
  isAnonymous: number;
  tags: string | null;
  metadata: string | null;
  modificationDate: number | null;
  lastCloudSync: number | null;
  playCount: number;
  winCount: number;
}

interface PlayRow {
  sqliteId: number;
  uuid: string | null;
  playDate: number | null;
  entryDate: number | null;
  modificationDate: number | null;
  lastCloudSync: number | null;
  durationMin: number;
  comments: string | null;
  board: string | null;
  ignored: number;
  manualWinner: number;
  playerCount: number;
  rounds: number;
  rating: number;
  scoringSetting: number;
  usesTeams: number;
  bggId: number | null;
  importPlayId: number | null;
  metadata: string | null;
  gameUuid: string | null;
  gameName: string | null;
  gameBggId: number | null;
  locationUuid: string | null;
  locationName: string | null;
}

interface PlayerScoreRow {
  playId: number;
  uuid: string | null;
  name: string | null;
  anonymousName: string | null;
  score: string | null;
  winner: number;
  startPlayer: number;
  rank: number;
  role: string | null;
  team: string | null;
  teamRole: string | null;
  seatOrder: number;
  startPosition: string | null;
  newPlayer: number;
  metadata: string | null;
}

const gameInputSchema = z.object({
  uuid: z.string().min(1).optional(),
  name: z.string().min(1),
  sourceGameId: z.string().min(1).optional(),
  bggId: z.number().int().positive().nullish(),
  highestWins: z.boolean().optional(),
  highestScoreWins: z.boolean().optional(),
  noPoints: z.boolean().optional(),
  usesTeams: z.boolean().optional(),
}).passthrough();

const playerInputSchema = z.object({
  uuid: z.string().min(1).optional(),
  name: z.string().min(1),
  sourcePlayerId: z.string().min(1).optional(),
  startPlayer: z.boolean().optional(),
  winner: z.boolean().optional(),
  score: z.union([z.number(), z.string()]).nullish(),
  rank: z.number().int().positive().nullish(),
  role: z.string().nullish(),
  team: z.string().nullish(),
  teamRole: z.string().nullish(),
}).passthrough();

const playInputSchema = z.object({
  uuid: z.string().min(1).optional(),
  sourceName: z.string().min(1).optional(),
  sourcePlayId: z.string().min(1).optional(),
  playDate: z.string().min(1).optional(),
  durationMin: z.number().int().nonnegative().nullish(),
  comments: z.string().nullish(),
  board: z.string().nullish(),
  location: z.union([
    z.string(),
    z.object({ name: z.string().min(1) }).passthrough(),
  ]).nullish(),
  game: gameInputSchema,
  players: z.array(playerInputSchema),
}).passthrough();

type PlayInput = z.infer<typeof playInputSchema>;

interface RecordResult {
  playUuid: string;
  alreadyExists: boolean;
  createdPlayers: string[];
}

interface SyncResult {
  playUuid: string;
  action: 'created' | 'updated';
  createdPlayers: string[];
}

if (import.meta.main) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function runCli(): Promise<void> {
  await yargs(hideBin(process.argv))
    .scriptName('bgstats')
    .version(false)
    .usage('$0 <command> [options]')
    .parserConfiguration({
      'strip-aliased': true,
      'strip-dashed': true,
    })
    .command(
      'read <entity>',
      'Read games, plays, or players from the local BG Stats database.',
      command => command
        .positional('entity', {
          type: 'string',
          choices: READ_ENTITIES,
          demandOption: true,
          describe: 'Entity collection to read.',
        })
        .option('database', {
          type: 'string',
          default: defaultDatabasePath(),
          describe: 'Path to the BG Stats Core Data SQLite database.',
        })
        .option('format', {
          alias: ['f'],
          type: 'string',
          choices: OUTPUT_FORMATS,
          default: 'json',
          describe: 'Output format.',
        })
        .option('limit', {
          alias: ['l'],
          type: 'number',
          describe: 'Maximum number of records to return.',
        }),
      argv => {
        if (argv.limit != null && (!Number.isInteger(argv.limit) || argv.limit < 1)) {
          throw new Error('--limit must be a positive integer.');
        }
        const records = readEntities(argv.database, argv.entity as ReadEntity, argv.limit);
        printRecords(argv.entity as ReadEntity, records, argv.format as OutputFormat);
      },
    )
    .command(
      'write plays [input]',
      'Record one completed play directly in BG Stats.',
      command => command
        .positional('input', {
          type: 'string',
          default: '-',
          describe: 'JSON file containing one play, or - to read stdin.',
        })
        .option('database', {
          type: 'string',
          default: defaultDatabasePath(),
          describe: 'Path to the BG Stats Core Data SQLite database.',
        })
        .option('review', {
          type: 'boolean',
          default: false,
          describe: 'Open the play in the BG Stats confirmation screen instead of recording it headlessly.',
        })
        .option('sync', {
          type: 'boolean',
          default: true,
          describe: 'Open, sync, and close BG Stats before and after a direct write.',
        })
        .option('sync-timeout', {
          type: 'number',
          default: DEFAULT_SYNC_TIMEOUT_SECONDS,
          describe: 'Seconds to wait for each BG Stats Cloud Sync.',
        })
        .option('source-name', {
          type: 'string',
          describe: `Import source used for remembered matches; defaults to ${DEFAULT_SOURCE_NAME}.`,
        })
        .example(
          '$0 write plays play.json',
          'Sync BG Stats, record one play, sync it to the cloud, and close the app.',
        ),
      async argv => {
        if (!Number.isFinite(argv.syncTimeout) || argv.syncTimeout < 1) {
          throw new Error('--sync-timeout must be at least 1 second.');
        }
        const input = playInputSchema.parse(await readPlayInput(argv.input));
        if (argv.review) {
          openPlayForReview(input, argv.sourceName);
          return;
        }
        await recordPlayDirectly(input, {
          databasePath: argv.database,
          sourceName: argv.sourceName,
          sync: argv.sync,
          syncTimeoutSeconds: argv.syncTimeout,
        });
      },
    )
    .command(
      'sync plays [input]',
      'Make source-backed plays authoritative in BG Stats.',
      command => command
        .positional('input', {
          type: 'string',
          default: '-',
          describe: 'JSON file containing one play or an array of plays, or - to read stdin.',
        })
        .option('database', {
          type: 'string',
          default: defaultDatabasePath(),
          describe: 'Path to the BG Stats Core Data SQLite database.',
        })
        .option('sync', {
          type: 'boolean',
          default: true,
          describe: 'Open, sync, and close BG Stats before and after updating the store.',
        })
        .option('sync-timeout', {
          type: 'number',
          default: DEFAULT_SYNC_TIMEOUT_SECONDS,
          describe: 'Seconds to wait for each BG Stats Cloud Sync.',
        })
        .option('source-name', {
          type: 'string',
          describe: 'Override the source name for every supplied play.',
        })
        .example(
          '$0 sync plays clocktracker.json',
          'Update matched plays in place and record new source plays in one guarded batch.',
        ),
      async argv => {
        if (!Number.isFinite(argv.syncTimeout) || argv.syncTimeout < 1) {
          throw new Error('--sync-timeout must be at least 1 second.');
        }
        const inputs = (await readPlayInputs(argv.input)).map(value => playInputSchema.parse(value));
        await syncPlaysDirectly(inputs, {
          databasePath: argv.database,
          sourceName: argv.sourceName,
          sync: argv.sync,
          syncTimeoutSeconds: argv.syncTimeout,
        });
      },
    )
    .strict()
    .strictCommands()
    .demandCommand(1, 'Choose a BG Stats command.')
    .recommendCommands()
    .wrap(process.stdout.columns || 100)
    .fail(failWithFullHelp)
    .help()
    .parseAsync();
}

function defaultDatabasePath(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  return path.join(
    home,
    'Library',
    'Containers',
    'nl.vissering.BoardGameStats',
    'Data',
    'Documents',
    'Model.sqlite',
  );
}

function readEntities(databasePath: string, entity: ReadEntity, limit?: number): object[] {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    database.run('PRAGMA query_only = ON');
    assertBgStatsDatabase(database);
    const records = entity === 'games'
      ? readGames(database)
      : entity === 'players'
        ? readPlayers(database)
        : readPlays(database);
    return limit == null ? records : records.slice(0, limit);
  } finally {
    database.close();
  }
}

function assertBgStatsDatabase(database: Database): void {
  const rows = database.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ZGAME', 'ZPLAY', 'ZPLAYER', 'ZPLAYERSCORE')",
  ).all() as Array<{ name: string }>;
  if (rows.length !== 4) {
    throw new Error('The selected database does not look like a supported BG Stats database.');
  }
}

function readGames(database: Database): object[] {
  const rows = database.query(`
    SELECT
      game.ZUUID AS uuid,
      game.ZNAME AS name,
      NULLIF(game.ZBGGID, 0) AS bggId,
      game.ZBGGNAME AS bggName,
      NULLIF(game.ZBGGYEAR, 0) AS bggYear,
      game.ZCOOPERATIVE AS cooperative,
      game.ZHIGHESTSCOREWINS AS highestScoreWins,
      game.ZNOPOINTS AS noPoints,
      game.ZUSESTEAMS AS usesTeams,
      game.ZMINPLAYERCOUNT AS minPlayers,
      game.ZMAXPLAYERCOUNT AS maxPlayers,
      game.ZMINPLAYTIME AS minPlaytime,
      game.ZMAXPLAYTIME AS maxPlaytime,
      game.ZISBASEGAME AS isBaseGame,
      game.ZISEXPANSION AS isExpansion,
      game.ZRATING AS rating,
      game.ZTAGS AS tags,
      game.ZMETADATA AS metadata,
      game.ZMODIFICATIONDATETIME AS modificationDate,
      game.ZLASTCLOUDSYNC AS lastCloudSync,
      COUNT(play.Z_PK) AS playCount
    FROM ZGAME game
    LEFT JOIN ZPLAY play ON play.ZPLAYEDGAME = game.Z_PK
    GROUP BY game.Z_PK
    ORDER BY game.ZNAME COLLATE NOCASE, game.ZUUID
  `).all() as GameRow[];

  return rows.map(row => ({
    uuid: row.uuid,
    name: row.name,
    bggId: row.bggId,
    bggName: row.bggName,
    bggYear: row.bggYear,
    cooperative: toBoolean(row.cooperative),
    highestScoreWins: toBoolean(row.highestScoreWins),
    noPoints: toBoolean(row.noPoints),
    usesTeams: toBoolean(row.usesTeams),
    minPlayers: row.minPlayers,
    maxPlayers: row.maxPlayers,
    minPlaytime: row.minPlaytime,
    maxPlaytime: row.maxPlaytime,
    isBaseGame: toBoolean(row.isBaseGame),
    isExpansion: toBoolean(row.isExpansion),
    rating: row.rating / 10,
    playCount: row.playCount,
    tags: parseJson(row.tags),
    metadata: parseJson(row.metadata),
    modificationDate: toIsoDate(row.modificationDate),
    lastCloudSync: toIsoDate(row.lastCloudSync),
  }));
}

function readPlayers(database: Database): object[] {
  const rows = database.query(`
    SELECT
      player.ZUUID AS uuid,
      player.ZNAME AS name,
      player.ZBGGNAME AS bggUsername,
      player.ZISME AS isMe,
      player.ZISANONYMOUS AS isAnonymous,
      player.ZTAGS AS tags,
      player.ZMETADATA AS metadata,
      player.ZMODIFICATIONDATETIME AS modificationDate,
      player.ZLASTCLOUDSYNC AS lastCloudSync,
      COUNT(score.Z_PK) AS playCount,
      COALESCE(SUM(CASE WHEN score.ZWIN = 1 THEN 1 ELSE 0 END), 0) AS winCount
    FROM ZPLAYER player
    LEFT JOIN ZPLAYERSCORE score ON score.ZPLAYER = player.Z_PK
    GROUP BY player.Z_PK
    ORDER BY player.ZNAME COLLATE NOCASE, player.ZUUID
  `).all() as PlayerRow[];

  return rows.map(row => ({
    uuid: row.uuid,
    name: row.name,
    bggUsername: row.bggUsername,
    isMe: toBoolean(row.isMe),
    isAnonymous: toBoolean(row.isAnonymous),
    playCount: row.playCount,
    winCount: row.winCount,
    tags: parseJson(row.tags),
    metadata: parseJson(row.metadata),
    modificationDate: toIsoDate(row.modificationDate),
    lastCloudSync: toIsoDate(row.lastCloudSync),
  }));
}

function readPlays(database: Database): object[] {
  const rows = database.query(`
    SELECT
      play.Z_PK AS sqliteId,
      play.ZUUID AS uuid,
      play.ZPLAYDATETIME AS playDate,
      play.ZENTRYDATETIME AS entryDate,
      play.ZMODIFICATIONDATETIME AS modificationDate,
      play.ZLASTCLOUDSYNC AS lastCloudSync,
      play.ZDURATION AS durationMin,
      play.ZCOMMENTS AS comments,
      play.ZBOARD AS board,
      play.ZIGNORESTATS AS ignored,
      play.ZMANUALWINNER AS manualWinner,
      play.ZPLAYERCOUNT AS playerCount,
      play.ZROUNDS AS rounds,
      play.ZRATING AS rating,
      play.ZSCORINGSETTING AS scoringSetting,
      play.ZUSESTEAMS AS usesTeams,
      NULLIF(play.ZBGGID, 0) AS bggId,
      NULLIF(play.ZIMPORTPLAYID, 0) AS importPlayId,
      play.ZMETADATA AS metadata,
      game.ZUUID AS gameUuid,
      game.ZNAME AS gameName,
      NULLIF(game.ZBGGID, 0) AS gameBggId,
      location.ZUUID AS locationUuid,
      location.ZNAME AS locationName
    FROM ZPLAY play
    LEFT JOIN ZGAME game ON game.Z_PK = play.ZPLAYEDGAME
    LEFT JOIN ZLOCATION location ON location.Z_PK = play.ZPLAYLOCATION
    ORDER BY play.ZPLAYDATETIME DESC, play.Z_PK DESC
  `).all() as PlayRow[];

  const scores = database.query(`
    SELECT
      score.ZPLAY AS playId,
      player.ZUUID AS uuid,
      player.ZNAME AS name,
      score.ZANONYMOUSNAME AS anonymousName,
      score.ZSCORE AS score,
      score.ZWIN AS winner,
      score.ZISSTARTPLAYER AS startPlayer,
      score.ZRANK AS rank,
      score.ZROLE AS role,
      score.ZTEAM AS team,
      score.ZTEAMROLE AS teamRole,
      score.ZSEATORDER AS seatOrder,
      score.ZSTARTPOSITION AS startPosition,
      score.ZISNEWPLAYER AS newPlayer,
      score.ZMETADATA AS metadata
    FROM ZPLAYERSCORE score
    LEFT JOIN ZPLAYER player ON player.Z_PK = score.ZPLAYER
    ORDER BY score.ZPLAY, score.ZSEATORDER, score.Z_PK
  `).all() as PlayerScoreRow[];

  const scoresByPlay = Map.groupBy(scores, score => score.playId);
  return rows.map(row => ({
    uuid: row.uuid,
    playDate: toIsoDate(row.playDate),
    entryDate: toIsoDate(row.entryDate),
    durationMin: row.durationMin,
    comments: row.comments,
    board: row.board,
    ignored: toBoolean(row.ignored),
    manualWinner: toBoolean(row.manualWinner),
    playerCount: row.playerCount,
    rounds: row.rounds,
    rating: row.rating / 10,
    scoringSetting: row.scoringSetting,
    usesTeams: toBoolean(row.usesTeams),
    bggId: row.bggId,
    importPlayId: row.importPlayId,
    game: {
      uuid: row.gameUuid,
      name: row.gameName,
      bggId: row.gameBggId,
    },
    location: row.locationName == null ? null : {
      uuid: row.locationUuid,
      name: row.locationName,
    },
    players: (scoresByPlay.get(row.sqliteId) ?? []).map(score => ({
      uuid: score.uuid,
      name: score.anonymousName || score.name,
      score: score.score,
      winner: toBoolean(score.winner),
      startPlayer: toBoolean(score.startPlayer),
      rank: score.rank || null,
      role: score.role,
      team: score.team,
      teamRole: score.teamRole,
      seatOrder: score.seatOrder || null,
      startPosition: score.startPosition,
      newPlayer: toBoolean(score.newPlayer),
      metadata: parseJson(score.metadata),
    })),
    metadata: parseJson(row.metadata),
    modificationDate: toIsoDate(row.modificationDate),
    lastCloudSync: toIsoDate(row.lastCloudSync),
  }));
}

function printRecords(entity: ReadEntity, records: object[], format: OutputFormat): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }

  if (entity === 'plays') {
    console.table(records.map(record => {
      const play = record as {
        uuid: string | null;
        playDate: string | null;
        game: { name: string | null };
        location: { name: string | null } | null;
        durationMin: number;
        players: Array<{ name: string | null }>;
      };
      return {
        uuid: play.uuid,
        playDate: play.playDate,
        game: play.game.name,
        location: play.location?.name ?? null,
        durationMin: play.durationMin,
        players: play.players.map(player => player.name).filter(Boolean).join(', '),
      };
    }));
    return;
  }

  console.table(records.map(record => {
    const value = record as Record<string, unknown>;
    return entity === 'games'
      ? pick(value, ['uuid', 'name', 'bggId', 'bggYear', 'rating', 'playCount'])
      : pick(value, ['uuid', 'name', 'bggUsername', 'isMe', 'playCount', 'winCount']);
  }));
}

async function readJsonInput(inputPath: string): Promise<unknown> {
  const text = inputPath === '-'
    ? await Bun.stdin.text()
    : readFileSync(path.resolve(inputPath), 'utf8');
  if (!text.trim()) {
    throw new Error('No play JSON was provided. Pass a file or pipe one JSON object to stdin.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function readPlayInput(inputPath: string): Promise<unknown> {
  const parsed = await readJsonInput(inputPath);
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed.length !== 1) {
    throw new Error('write plays currently accepts exactly one play at a time.');
  }
  return parsed[0];
}

async function readPlayInputs(inputPath: string): Promise<unknown[]> {
  const parsed = await readJsonInput(inputPath);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) {
    throw new Error('No plays were provided.');
  }
  return values;
}

function openPlayForReview(input: PlayInput, sourceNameOverride?: string): void {
  const payload = createImportPayload(input, sourceNameOverride);
  const url = `bgstats://app.bgstatsapp.com/createPlay.html?data=${encodeURIComponent(JSON.stringify(payload))}`;
  const result = spawnSync('open', [url], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not open BG Stats (exit code ${result.status ?? 'unknown'}).`);
  }
  process.stdout.write('Opened BG Stats to confirm and import the play.\n');
}

async function recordPlayDirectly(
  input: PlayInput,
  options: {
    databasePath: string;
    sourceName?: string;
    sync: boolean;
    syncTimeoutSeconds: number;
  },
): Promise<void> {
  const databasePath = path.resolve(options.databasePath);
  const payload = createRecordPayload(input, options.sourceName);
  let postSyncNotBefore: number | undefined;

  if (options.sync) {
    await syncAndCloseBgStats(
      'before recording',
      options.syncTimeoutSeconds,
      true,
      () => isCloudSyncComplete(databasePath),
    );
    postSyncNotBefore = Date.now() + CLOUD_SYNC_COOLDOWN_MS;
  } else if (isBgStatsRunning()) {
    throw new Error('BG Stats must be closed before a direct write. Quit it or omit --no-sync.');
  }

  assertNoPendingCloudSync(databasePath);
  const backupPath = backupDatabase(databasePath);
  let result: RecordResult;
  try {
    result = runStoreHelper<RecordResult>(['record', databasePath, defaultModelPath()], payload);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Backup preserved at ${backupPath}.`);
  }

  if (result.alreadyExists) {
    process.stdout.write(`Play ${result.playUuid} was already recorded; no data was changed.\n`);
    process.stdout.write(`Backup: ${backupPath}\n`);
    return;
  }

  if (options.sync) {
    try {
      await syncAndCloseBgStats(
        'after recording',
        options.syncTimeoutSeconds,
        false,
        () => isCloudSyncComplete(databasePath),
        postSyncNotBefore,
      );
      assertPlayCloudSynced(databasePath, result.playUuid);
    } catch (error) {
      throw new Error(
        `Play ${result.playUuid} is recorded locally, but post-write sync verification failed: `
        + `${error instanceof Error ? error.message : String(error)} Backup preserved at ${backupPath}.`,
      );
    }
  }

  process.stdout.write(`Recorded play ${result.playUuid}.\n`);
  if (result.createdPlayers.length > 0) {
    process.stdout.write(`Created players: ${result.createdPlayers.join(', ')}\n`);
  }
  process.stdout.write(`Backup: ${backupPath}\n`);
}

async function syncPlaysDirectly(
  inputs: PlayInput[],
  options: {
    databasePath: string;
    sourceName?: string;
    sync: boolean;
    syncTimeoutSeconds: number;
  },
): Promise<void> {
  const databasePath = path.resolve(options.databasePath);
  const payloads = inputs
    .map(input => createRecordPayload(input, options.sourceName))
    .sort((left, right) => left.playDate.localeCompare(right.playDate));
  const sourceKeys = payloads.map(payload => `${payload.sourceName}\0${payload.sourcePlayId}`);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new Error('The sync input contains duplicate source play identities.');
  }

  let postSyncNotBefore: number | undefined;
  if (options.sync) {
    await syncAndCloseBgStats(
      'before source sync',
      options.syncTimeoutSeconds,
      true,
      () => isCloudSyncComplete(databasePath),
    );
    postSyncNotBefore = Date.now() + CLOUD_SYNC_COOLDOWN_MS;
  } else if (isBgStatsRunning()) {
    throw new Error('BG Stats must be closed before a direct write. Quit it or omit --no-sync.');
  }

  assertNoPendingCloudSync(databasePath);
  const backupPath = backupDatabase(databasePath);
  let results: SyncResult[];
  try {
    results = runStoreHelper<SyncResult[]>(['sync', databasePath, defaultModelPath()], payloads);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Backup preserved at ${backupPath}.`);
  }

  if (options.sync) {
    try {
      await syncAndCloseBgStats(
        'after source sync',
        options.syncTimeoutSeconds,
        false,
        () => isCloudSyncComplete(databasePath),
        postSyncNotBefore,
      );
      for (const result of results) {
        assertPlayCloudSynced(databasePath, result.playUuid);
      }
    } catch (error) {
      throw new Error(
        `The plays were updated locally, but post-write sync verification failed: `
        + `${error instanceof Error ? error.message : String(error)} Backup preserved at ${backupPath}.`,
      );
    }
  }

  const created = results.filter(result => result.action === 'created').length;
  const updated = results.length - created;
  const createdPlayers = [...new Set(results.flatMap(result => result.createdPlayers))];
  process.stdout.write(`Synced ${results.length} plays: ${updated} updated, ${created} created.\n`);
  if (createdPlayers.length > 0) {
    process.stdout.write(`Created players: ${createdPlayers.join(', ')}\n`);
  }
  process.stdout.write(`Backup: ${backupPath}\n`);
}

function createRecordPayload(input: PlayInput, sourceNameOverride?: string) {
  const sourceName = sourceNameOverride ?? input.sourceName ?? DEFAULT_SOURCE_NAME;
  if (!sourceName.trim()) {
    throw new Error('--source-name must not be empty.');
  }
  return {
    uuid: input.uuid,
    sourceName,
    sourcePlayId: input.sourcePlayId ?? input.uuid ?? crypto.randomUUID(),
    playDate: input.playDate ?? new Date().toISOString(),
    durationMin: input.durationMin ?? undefined,
    comments: input.comments ?? undefined,
    board: input.board ?? undefined,
    location: typeof input.location === 'string'
      ? { name: input.location }
      : input.location ?? undefined,
    game: {
      uuid: input.game.uuid,
      name: input.game.name,
      bggId: input.game.bggId ?? undefined,
      highestWins: input.game.highestWins,
      highestScoreWins: input.game.highestScoreWins,
      noPoints: input.game.noPoints,
      usesTeams: input.game.usesTeams,
    },
    players: input.players.map(player => ({
      uuid: player.uuid,
      name: player.name,
      sourcePlayerId: player.sourcePlayerId,
      startPlayer: player.startPlayer ?? false,
      winner: player.winner ?? false,
      score: player.score ?? undefined,
      rank: player.rank ?? undefined,
      role: player.role ?? undefined,
      team: player.team ?? undefined,
      teamRole: player.teamRole ?? undefined,
    })),
  };
}

function assertNoPendingCloudSync(databasePath: string): void {
  const pending = pendingCloudSync(databasePath);
  if (pending.length > 0) {
    throw new Error(`BG Stats still has unsynced local data (${pending.join(', ')}); no write was attempted.`);
  }
}

function isCloudSyncComplete(databasePath: string): boolean {
  return pendingCloudSync(databasePath).length === 0;
}

function pendingCloudSync(databasePath: string): string[] {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    database.run('PRAGMA query_only = ON');
    assertBgStatsDatabase(database);
    const entities = [
      ['games', 'ZGAME'],
      ['locations', 'ZLOCATION'],
      ['plays', 'ZPLAY'],
      ['players', 'ZPLAYER'],
    ] as const;
    return entities.flatMap(([name, table]) => {
      const row = database.query(`
        SELECT COUNT(*) AS count
        FROM ${table}
        WHERE ZMODIFICATIONDATETIME IS NULL
           OR ZLASTCLOUDSYNC IS NULL
           OR ZMODIFICATIONDATETIME > ZLASTCLOUDSYNC
      `).get() as { count: number };
      return row.count > 0 ? [`${row.count} ${name}`] : [];
    });
  } finally {
    database.close();
  }
}

function backupDatabase(databasePath: string): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  const backupDirectory = path.join(home, 'Library', 'Application Support', 'bgstats-cli', 'backups');
  mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
  const backupPath = path.join(backupDirectory, `Model-${timestamp}.sqlite`);
  if (existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite existing backup ${backupPath}.`);
  }
  const escapedBackupPath = backupPath.replaceAll("'", "''");
  const result = spawnSync('sqlite3', [databasePath, `.backup '${escapedBackupPath}'`], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Could not back up the BG Stats database (exit code ${result.status ?? 'unknown'}).`);
  }
  return backupPath;
}

function assertPlayCloudSynced(databasePath: string, playUuid: string): void {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = database.query(`
      SELECT
        ZLASTCLOUDSYNC AS lastCloudSync,
        ZMODIFICATIONDATETIME AS modificationDate
      FROM ZPLAY
      WHERE ZUUID = ?
    `).get(playUuid) as { lastCloudSync: number | null; modificationDate: number | null } | null;
    if (!row) {
      throw new Error(`BG Stats did not retain recorded play ${playUuid}. The backup was preserved.`);
    }
    if (row.lastCloudSync == null || row.modificationDate == null || row.lastCloudSync < row.modificationDate) {
      throw new Error(`Play ${playUuid} is recorded locally but Cloud Sync did not confirm it.`);
    }
  } finally {
    database.close();
  }
}

async function syncAndCloseBgStats(
  phase: string,
  timeoutSeconds: number,
  acceptRecentSync: boolean,
  isComplete?: () => boolean,
  notBefore?: number,
): Promise<void> {
  if (isBgStatsRunning()) {
    quitBgStats();
  }
  while (notBefore != null && Date.now() < notBefore) {
    await Bun.sleep(Math.min(30_000, notBefore - Date.now()));
  }
  const previousMarker = readCloudSyncMarker();
  const launched = spawnSync('open', ['-a', BG_STATS_APP_NAME], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (launched.error) {
    throw launched.error;
  }
  if (launched.status !== 0) {
    throw new Error(launched.stderr.trim() || `Could not open ${BG_STATS_APP_NAME}.`);
  }

  try {
    await waitFor(() => isBgStatsRunning(), 15_000, 'BG Stats did not finish launching.');
    runStoreHelper(['activate-app']);
    if (isComplete && !isComplete()) {
      await waitFor(
        isComplete,
        timeoutSeconds * 1000,
        `BG Stats Cloud Sync did not finish ${phase} within ${timeoutSeconds} seconds.`,
      );
    } else if (acceptRecentSync && isRecentSyncMarker(previousMarker)) {
      await Bun.sleep(5_000);
    } else {
      await waitFor(
        () => {
          const marker = readCloudSyncMarker();
          return marker != null && marker !== previousMarker;
        },
        timeoutSeconds * 1000,
        `BG Stats Cloud Sync did not finish ${phase} within ${timeoutSeconds} seconds.`,
      );
    }
  } finally {
    if (isBgStatsRunning()) {
      quitBgStats();
    }
  }
}

function isRecentSyncMarker(marker: string | null): boolean {
  if (!marker) {
    return false;
  }
  const timestamp = Date.parse(marker);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= RECENT_SYNC_MAX_AGE_MS;
}

function readCloudSyncMarker(): string | null {
  const result = spawnSync('/usr/bin/plutil', [
    '-extract',
    'LastSuccessfulCloudSync',
    'raw',
    '-o',
    '-',
    defaultPreferencesPath(),
  ], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ETIMEDOUT') {
      throw new Error('macOS blocked access to BG Stats data. Allow access to data from other apps, then retry.');
    }
    throw result.error;
  }
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function isBgStatsRunning(): boolean {
  const result = spawnSync('pgrep', ['-f', 'Board Game Stats\\.app/Board Game Stats$'], {
    encoding: 'utf8',
    timeout: 3_000,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function quitBgStats(): void {
  runStoreHelper(['quit-app']);
}

function runStoreHelper<T = void>(arguments_: string[], input?: unknown): T {
  const result = spawnSync('swift', [defaultStoreHelperPath(), ...arguments_], {
    encoding: 'utf8',
    input: input == null ? undefined : JSON.stringify(input),
    maxBuffer: 10_000_000,
    timeout: 60_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `The BG Stats store helper failed (exit code ${result.status ?? 'unknown'}).`);
  }
  return (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as T;
}

async function waitFor(check: () => boolean, timeoutMs: number, errorMessage: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(errorMessage);
}

function defaultModelPath(): string {
  return '/Applications/BG Stats.app/Wrapper/Board Game Stats.app/Model.momd';
}

function defaultStoreHelperPath(): string {
  return path.join(import.meta.dir, 'bgstatsStore.swift');
}

function defaultPreferencesPath(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  return path.join(
    home,
    'Library',
    'Containers',
    BG_STATS_BUNDLE_ID,
    'Data',
    'Library',
    'Preferences',
    `${BG_STATS_BUNDLE_ID}.plist`,
  );
}

function createImportPayload(input: PlayInput, sourceNameOverride?: string): object {
  return {
    sourceName: sourceNameOverride ?? input.sourceName ?? DEFAULT_SOURCE_NAME,
    sourcePlayId: input.sourcePlayId ?? input.uuid ?? crypto.randomUUID(),
    playDate: formatBgStatsDate(input.playDate),
    durationMin: input.durationMin ?? undefined,
    comments: input.comments ?? undefined,
    board: input.board ?? undefined,
    location: typeof input.location === 'string' ? input.location : input.location?.name,
    game: {
      name: input.game.name,
      sourceGameId: input.game.sourceGameId
        ?? input.game.uuid
        ?? (input.game.bggId ? `bgg:${input.game.bggId}` : `name:${normalizeSourceId(input.game.name)}`),
      bggId: input.game.bggId ?? undefined,
      highestWins: input.game.highestWins ?? input.game.highestScoreWins,
      noPoints: input.game.noPoints,
      usesTeams: input.game.usesTeams,
    },
    players: input.players.map(player => ({
      name: player.name,
      sourcePlayerId: player.sourcePlayerId ?? player.uuid ?? `name:${normalizeSourceId(player.name)}`,
      startPlayer: player.startPlayer ?? false,
      winner: player.winner ?? false,
      score: normalizeScore(player.score),
      rank: player.rank ?? undefined,
      role: player.role ?? undefined,
      team: player.team ?? undefined,
      teamRole: player.teamRole ?? undefined,
    })),
  };
}

function formatBgStatsDate(value?: string): string {
  const normalized = value?.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = normalized ? new Date(normalized) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid playDate: ${value}`);
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeScore(value: string | number | null | undefined): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) {
    throw new Error(`BG Stats play links only support numeric scores; received ${JSON.stringify(value)}.`);
  }
  return score;
}

function normalizeSourceId(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, '-');
}

function toBoolean(value: number | null): boolean {
  return value === 1;
}

function toIsoDate(value: number | null): string | null {
  if (value == null) {
    return null;
  }
  return new Date((value + APPLE_REFERENCE_DATE_UNIX_SECONDS) * 1000).toISOString();
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
