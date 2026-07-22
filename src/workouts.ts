#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import env from './env';
import {
  OUTPUT_FORMATS,
  parseOutputFormat,
  renderCsvRecords,
  renderTableRecords,
  type CsvValue,
  type OutputFormat,
} from './utils/output';

const SOURCE_PATH = 'api://macrofactor/workouts';
const FIREBASE_PROJECT_ID = 'sbs-diet-app';
const FIRESTORE_DOCUMENTS_PATH = `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DOCUMENTS_PATH}`;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MICROS_PER_SECOND = 1_000_000;
const SECONDS_PER_DAY = 24 * 60 * 60;
const WORKOUT_HISTORY_PAGE_SIZE = 200;
const KG_TO_LB = 2.2046226218;
const DISPLAY_LOCALE = 'en-US';
const CURRENT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
const FIREBASE_AUTH_CONFIGS = [
  {
    label: 'Workouts',
    apiKey: 'AIzaSyDXXn2OUEq8XI8TpRL7ae38pMAOyR7FCec',
    bundleId: 'com.sbs.train',
  },
  {
    label: 'MacroFactor',
    apiKey: 'AIzaSyA17Uwy37irVEQSwz6PIyX3wnkHrDBeleA',
    bundleId: 'com.sbs.diet',
  },
] as const;
const WORKOUTS_EXERCISE_NAME_BY_ID: Record<string, string> = {
  '1a05c6f170d8802ba26bf25efbec5e68': 'Dumbbell Overhead Press',
  '1a05c6f170d8806ab70ee93a5c79d733': 'Dumbbell Bench Press',
  '1a05c6f170d8807c9f16f226db24074d': 'Barbell Bench Press',
  '1a05c6f170d8809da1e7fbc50ae7575b': 'Incline Barbell Bench Press',
  '1a05c6f170d880df946bdd6f42f0901c': 'Cable Fly',
  '1a15c6f170d880148cade872878baf4c': 'Prone Dumbbell Scapular Retraction',
  '1a15c6f170d88014a710f8ada9a1e94a': 'Face Pull',
  '1a15c6f170d8809b94d8f668bf45a229': 'Landmine Row',
  '1a15c6f170d880a19fdfee37bb2e5ee3': 'Machine Shoulder Press',
  '1a15c6f170d880a2ac20d8a1281d1d37': 'Chest-Supported T-Bar Row',
  '1a15c6f170d880b2a97ec3d948120f99': 'Lat Pulldown',
  '1a15c6f170d880d7b8cbf608580aaa50': 'Concentration Curl',
  '1a15c6f170d880f3b564c407768a11ac': 'Dumbbell Skull Crusher',
  '1a25c6f170d8800a86efdcb6f902b9a9': 'Smith Machine Back Squat',
  '1a25c6f170d8802ea9b9ce71cd9d3d67': 'Leg Press',
  '1a25c6f170d88079a926dde776766181': '45 Degree Leg Press',
  '1a35c6f170d88050a8b7db0d4f1bc8f2': 'Ab Crunch Machine',
  '1a35c6f170d8807c8999d24ee4aaf939': 'Kneeling Cable Crunch',
  '1a35c6f170d8808fa1c6e81741d5a44b': 'Smith Machine Good Morning',
  '1a35c6f170d880bebc64f4dce0d5f5f1': 'Romanian Deadlift',
  '1a35c6f170d880cdb0ded0d7ed778004': 'Standing Cable Crunch',
  '1a45c6f170d880fabcebd578763b9c46': 'Plank',
  '1b15c6f170d88066b8c7cbfb822f1045': 'V-Bar Triceps Pushdown',
  '1b25c6f170d8801a9fa3c2dd66d17fa4': 'Overhead Cable Triceps Extension',
  '2835c6f170d8809b876be6b88319b977': 'Plate-Loaded Ab Crunch',
  '2a15c6f170d8805aaf68ef29976580f7': 'Smith Machine Underhand Row',
  '2ab5c6f170d88056b4b7ecef4d1ae9b4': 'Low Pulley Face Pull',
  '2ab5c6f170d880839baed369debc0459': 'Chest-Supported Dumbbell Row',
};
const SUMMARY_COLUMNS = [
  'date',
  'time',
  'workout',
  'gym',
  'source',
  'program',
  'durationMin',
  'exerciseCount',
  'sets',
  'skippedSets',
  'exercises',
] as const;
const FULL_COLUMNS = [
  'date',
  'time',
  'workout',
  'gym',
  'source',
  'program',
  'cycle',
  'block',
  'exerciseIndex',
  'exerciseId',
  'exerciseNote',
  'setIndex',
  'setType',
  'fullReps',
  'partialReps',
  'actualRir',
  'targetMinReps',
  'targetMaxReps',
  'targetRir',
  'weightKg',
  'weightLb',
  'restSeconds',
  'durationSeconds',
  'distance',
  'isSkipped',
] as const;

interface FirebaseAuthConfig {
  label: string;
  apiKey: string;
  bundleId: string;
}

interface FirebaseSession {
  authConfig: FirebaseAuthConfig;
  idToken: string;
  refreshToken: string;
  expiresAtMs: number;
  userId: string;
}

interface FirestoreDocumentResponse {
  name?: string;
  fields?: Record<string, unknown>;
}

interface FirestoreListDocumentsResponse {
  documents?: FirestoreDocumentResponse[];
  nextPageToken?: string;
}

interface FirestoreValue {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  stringValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

interface FirestoreListedDocument {
  id: string;
  data: Record<string, unknown>;
}

interface FirebaseSignInResponse {
  idToken?: string;
  refreshToken?: string;
  expiresIn?: string;
  localId?: string;
}

interface FirebaseRefreshResponse {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
}

interface ResolvedWindow {
  startUnixSeconds: number;
  endUnixSeconds: number;
}

interface WorkoutsReport {
  generatedAt: string;
  sourcePath: string;
  timezone: string;
  window: {
    start: string;
    end: string;
  };
  matchedWorkouts: number;
  returnedWorkouts: number;
  workoutProfile: WorkoutProfile | null;
  activeProgram: TrainingProgram | null;
  workouts: WorkoutSession[];
}

interface WorkoutProfile {
  activeProgramId: string | null;
  userExerciseConfigCount: number;
  settings: Record<string, unknown>;
}

interface TrainingProgram {
  id: string;
  name: string | null;
  color: string | null;
  icon: string | null;
  numCycles: number | null;
  runIndefinitely: boolean | null;
  isPeriodized: boolean | null;
  dayCount: number;
  days: unknown[];
  workoutHistoryIds: string[];
}

interface ProgramDefinition extends Record<string, unknown> {
  name: string;
  days: unknown[];
}

interface WorkoutHistoryCommandArgs {
  days: number;
  start?: string;
  end?: string;
  limit?: number;
  format: string;
  output?: string;
  pretty: boolean;
}

interface CreateProgramCommandArgs {
  file: string;
  activate: boolean;
  dryRun: boolean;
}

interface WorkoutSource {
  runtimeType: string | null;
  programId: string | null;
  programName: string | null;
  programColor: string | null;
  programIcon: string | null;
  dayId: string | null;
  cycleIndex: number | null;
}

interface WorkoutSetTarget {
  id: string | null;
  minFullReps: number | null;
  maxFullReps: number | null;
  rir: number | null;
  restSeconds: number | null;
  durationSeconds: number | null;
  distance: number | null;
}

interface WorkoutSetValue {
  fullReps: number | null;
  partialReps: number | null;
  rir: number | null;
  weightKg: number | null;
  weightLb: number | null;
  restSeconds: number | null;
  durationSeconds: number | null;
  distance: number | null;
  isSkipped: boolean;
}

interface WorkoutSet {
  id: string | null;
  runtimeType: string | null;
  setType: string | null;
  segments: unknown[];
  target: WorkoutSetTarget | null;
  value: WorkoutSetValue | null;
}

interface WorkoutExercise {
  id: string | null;
  exerciseId: string | null;
  note: string | null;
  baseWeightKg: number | null;
  baseWeightLb: number | null;
  sets: WorkoutSet[];
}

interface WorkoutBlock {
  index: number;
  exercises: WorkoutExercise[];
}

interface WorkoutSummary {
  exerciseCount: number;
  setCount: number;
  skippedSets: number;
  completedSets: number;
}

interface WorkoutSession {
  id: string;
  name: string | null;
  startTime: string | null;
  startTimeLocal: string | null;
  durationMicros: number | null;
  durationSeconds: number | null;
  durationMinutes: number | null;
  gymId: string | null;
  gymName: string | null;
  gymIcon: string | null;
  source: WorkoutSource | null;
  summary: WorkoutSummary;
  blocks: WorkoutBlock[];
}

interface PreparedWorkoutSession {
  session: WorkoutSession;
  startTimestampMs: number | null;
}

type ConciseDateFormat = 'iso' | 'table' | 'csv';

if (import.meta.main) {
  void runCli();
}

async function runCli(): Promise<void> {
  try {
    await yargs(hideBin(process.argv))
      .scriptName('workouts')
      .strict()
      .command<WorkoutHistoryCommandArgs>(
        '$0',
        'List workout history',
        builder =>
          builder
            .option('days', {
              alias: ['d'],
              type: 'number',
              default: 30,
              describe: 'Lookback window in days when --start is not set',
            })
            .option('start', {
              type: 'string',
              describe: 'Start date/time in ISO format (e.g. 2026-02-01 or 2026-02-01T00:00:00Z)',
            })
            .option('end', {
              type: 'string',
              describe: 'End date/time in ISO format',
            })
            .option('limit', {
              alias: ['l'],
              type: 'number',
              describe: 'Maximum number of workouts to return',
            })
            .option('format', {
              alias: ['f'],
              type: 'string',
              choices: OUTPUT_FORMATS,
              default: 'table',
              describe: 'Output format',
            })
            .option('output', {
              alias: ['o'],
              type: 'string',
              describe: 'Write output to this file path',
            })
            .option('pretty', {
              type: 'boolean',
              default: true,
              describe: 'Pretty-print JSON output',
            }),
        runWorkoutHistoryCommand
      )
      .command<CreateProgramCommandArgs>(
        'program create <file>',
        'Create a training program from a JSON definition',
        builder =>
          builder
            .positional('file', {
              type: 'string',
              demandOption: true,
              describe: 'JSON program file, or - to read from stdin',
            })
            .option('activate', {
              type: 'boolean',
              default: false,
              describe: 'Make the new program active',
            })
            .option('dry-run', {
              type: 'boolean',
              default: false,
              describe: 'Validate and print the program without creating it',
            }),
        runCreateProgramCommand
      )
      .help()
      .version(false)
      .wrap(process.stdout.columns ?? 80)
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

async function runWorkoutHistoryCommand(args: WorkoutHistoryCommandArgs): Promise<void> {
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number.');
  }

  const credentials = parseMacrofactorCredentials(env.MACROFACTOR_CREDENTIALS);
  const window = resolveWindow({
    days: args.days,
    start: args.start,
    end: args.end,
  });
  const client = await WorkoutsApiClient.login(credentials.email, credentials.password);
  const [profileDocument, historyDocuments] = await Promise.all([
    client.getUserDocument('profiles/workout', 'Workouts profile request failed'),
    client.listUserCollection('workoutHistory', 'Workouts history request failed', WORKOUT_HISTORY_PAGE_SIZE),
  ]);
  const workoutProfile = parseWorkoutProfile(profileDocument);
  const activeProgramId = workoutProfile?.activeProgramId ?? null;
  const activeProgramDocument = activeProgramId
    ? await client.getUserDocument(`trainingProgram/${activeProgramId}`, `Workouts program request failed for ${activeProgramId}`)
    : null;
  const activeProgram = activeProgramId ? parseTrainingProgram(activeProgramId, activeProgramDocument) : null;
  const report = buildWorkoutsReport({
    workoutProfile,
    activeProgram,
    historyDocuments,
    window,
    limit: args.limit,
  });

  renderOutput({
    report,
    format: parseOutputFormat(args.format),
    outputPath: args.output,
    pretty: args.pretty,
  });
}

async function runCreateProgramCommand(args: CreateProgramCommandArgs): Promise<void> {
  const program = parseProgramDefinition(await readProgramDefinition(args.file));
  const id = createFirestoreDocumentId();

  if (!args.dryRun) {
    const credentials = parseMacrofactorCredentials(env.MACROFACTOR_CREDENTIALS);
    const client = await WorkoutsApiClient.login(credentials.email, credentials.password);
    await client.createTrainingProgram(id, program, args.activate);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        id,
        name: program.name,
        activated: args.activate && !args.dryRun,
        dryRun: args.dryRun,
        program,
      },
      null,
      2
    )}\n`
  );
}

async function readProgramDefinition(file: string): Promise<unknown> {
  const text = file === '-' || file === '' ? await Bun.stdin.text() : readFileSync(path.resolve(file), 'utf8');
  if (!text.trim()) {
    throw new Error('Program definition is empty.');
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Program definition is not valid JSON: ${message}`);
  }
}

function parseProgramDefinition(value: unknown): ProgramDefinition {
  const input = asRecord(value);
  if (!input) {
    throw new Error('Program definition must be a JSON object.');
  }

  const name = parseOptionalString(input.name);
  if (!name) {
    throw new Error('Program definition must include a non-empty name.');
  }
  if (!Array.isArray(input.days) || input.days.length === 0) {
    throw new Error('Program definition must include at least one day.');
  }
  if (input.days.some(day => !asRecord(day))) {
    throw new Error('Every program day must be a JSON object.');
  }
  if (input.numCycles != null) {
    const numCycles = parseNumberLike(input.numCycles);
    if (numCycles == null || !Number.isInteger(numCycles) || numCycles <= 0) {
      throw new Error('numCycles must be a positive integer.');
    }
  }
  for (const key of ['runIndefinitely', 'isPeriodized']) {
    if (input[key] != null && typeof input[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean.`);
    }
  }

  const { id: _id, dayCount: _dayCount, workoutHistoryIds: _workoutHistoryIds, ...program } = input;
  return {
    ...program,
    name,
    days: input.days,
    workoutCycleCompletions: [],
  };
}

function createFirestoreDocumentId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function serializeFirestoreFields(fields: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serializeFirestoreValue(value)]));
}

function serializeFirestoreValue(value: unknown): FirestoreValue {
  if (value == null) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Program definition contains a non-finite number.');
    }
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const values = value.map(serializeFirestoreValue);
    return values.length ? { arrayValue: { values } } : { arrayValue: {} };
  }
  const record = asRecord(value);
  if (record) {
    const fields = serializeFirestoreFields(record);
    return Object.keys(fields).length ? { mapValue: { fields } } : { mapValue: {} };
  }
  throw new Error(`Program definition contains an unsupported ${typeof value} value.`);
}

function renderOutput(options: {
  report: WorkoutsReport;
  format: OutputFormat;
  outputPath?: string;
  pretty: boolean;
}): void {
  if (options.format === 'table') {
    if (options.outputPath) {
      throw new Error('--output is not supported with --format=table. Use --format=csv or --format=json.');
    }
    renderTable(options.report);
    return;
  }

  const text =
    options.format === 'json'
      ? `${JSON.stringify(options.report, null, options.pretty ? 2 : 0)}\n`
      : options.format === 'csv:full'
        ? renderFullCsv(options.report)
        : renderSummaryCsv(options.report);

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    writeFileSync(outputPath, text, 'utf8');
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(text);
}

function renderTable(report: WorkoutsReport): void {
  if (report.activeProgram) {
    const label = report.activeProgram.name ?? report.activeProgram.id;
    process.stdout.write(`Active Program: ${label} (${report.activeProgram.dayCount} days)\n\n`);
  }
  renderTableRecords(toSummaryRows(report, { dateFormat: 'table' }));
}

function renderSummaryCsv(report: WorkoutsReport): string {
  return renderCsvRecords(toSummaryRows(report, { dateFormat: 'csv' }), SUMMARY_COLUMNS);
}

function renderFullCsv(report: WorkoutsReport): string {
  return renderCsvRecords(toFullRows(report, { dateFormat: 'csv' }), FULL_COLUMNS);
}

function buildWorkoutsReport(options: {
  workoutProfile: WorkoutProfile | null;
  activeProgram: TrainingProgram | null;
  historyDocuments: FirestoreListedDocument[];
  window: ResolvedWindow;
  limit?: number;
}): WorkoutsReport {
  const startMs = options.window.startUnixSeconds * 1000;
  const endMs = options.window.endUnixSeconds * 1000;
  const prepared = options.historyDocuments
    .map(document => parseWorkoutSession(document))
    .filter(
      (session): session is PreparedWorkoutSession =>
        session.startTimestampMs != null &&
        session.startTimestampMs >= startMs &&
        session.startTimestampMs <= endMs
    )
    .sort((a, b) => (b.startTimestampMs ?? 0) - (a.startTimestampMs ?? 0));

  const limited =
    options.limit && Number.isFinite(options.limit)
      ? prepared.slice(0, Math.floor(options.limit))
      : prepared;

  return {
    generatedAt: formatLocalIso(Date.now()),
    sourcePath: SOURCE_PATH,
    timezone: CURRENT_TIMEZONE,
    window: {
      start: toIso(options.window.startUnixSeconds),
      end: toIso(options.window.endUnixSeconds),
    },
    matchedWorkouts: prepared.length,
    returnedWorkouts: limited.length,
    workoutProfile: options.workoutProfile,
    activeProgram: options.activeProgram,
    workouts: limited.map(entry => entry.session),
  };
}

function toSummaryRows(
  report: WorkoutsReport,
  options?: { dateFormat?: ConciseDateFormat }
): Record<string, CsvValue>[] {
  const dateFormat = options?.dateFormat ?? 'iso';
  return report.workouts.map(workout => {
    const parts = getDateTimeParts(workout.startTimeLocal ?? workout.startTime, dateFormat);
    return {
      date: parts.date,
      time: parts.time,
      workout: workout.name ?? workout.id,
      gym: workout.gymName,
      source: workout.source?.runtimeType ?? null,
      program: workout.source?.programName ?? null,
      durationMin: workout.durationMinutes,
      exerciseCount: workout.summary.exerciseCount,
      sets: workout.summary.setCount,
      skippedSets: workout.summary.skippedSets,
      exercises: summarizeWorkoutExercises(workout),
    };
  });
}

function toFullRows(
  report: WorkoutsReport,
  options?: { dateFormat?: ConciseDateFormat }
): Record<string, CsvValue>[] {
  const dateFormat = options?.dateFormat ?? 'iso';
  const rows: Record<string, CsvValue>[] = [];

  for (const workout of report.workouts) {
    const parts = getDateTimeParts(workout.startTimeLocal ?? workout.startTime, dateFormat);
    for (const block of workout.blocks) {
      for (let exerciseIndex = 0; exerciseIndex < block.exercises.length; exerciseIndex += 1) {
        const exercise = block.exercises[exerciseIndex];
        for (let setIndex = 0; setIndex < exercise.sets.length; setIndex += 1) {
          const set = exercise.sets[setIndex];
          rows.push({
            date: parts.date,
            time: parts.time,
            workout: workout.name ?? workout.id,
            gym: workout.gymName,
            source: workout.source?.runtimeType ?? null,
            program: workout.source?.programName ?? null,
            cycle: workout.source?.cycleIndex ?? null,
            block: block.index,
            exerciseIndex: exerciseIndex + 1,
            exerciseId: exercise.exerciseId ?? exercise.id,
            exerciseNote: exercise.note,
            setIndex: setIndex + 1,
            setType: set.setType,
            fullReps: set.value?.fullReps ?? null,
            partialReps: set.value?.partialReps ?? null,
            actualRir: set.value?.rir ?? null,
            targetMinReps: set.target?.minFullReps ?? null,
            targetMaxReps: set.target?.maxFullReps ?? null,
            targetRir: set.target?.rir ?? null,
            weightKg: set.value?.weightKg ?? exercise.baseWeightKg,
            weightLb: set.value?.weightLb ?? exercise.baseWeightLb,
            restSeconds: set.value?.restSeconds ?? set.target?.restSeconds ?? null,
            durationSeconds: set.value?.durationSeconds ?? set.target?.durationSeconds ?? null,
            distance: set.value?.distance ?? set.target?.distance ?? null,
            isSkipped: (set.value?.isSkipped ?? false) ? 'true' : 'false',
          });
        }
      }
    }
  }

  return rows;
}

function parseWorkoutProfile(document: Record<string, unknown> | null): WorkoutProfile | null {
  if (!document) {
    return null;
  }

  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'activeProgramId' || key === 'userExerciseConfigs') {
      continue;
    }
    settings[key] = value;
  }

  const exerciseConfigs = asRecord(document.userExerciseConfigs);
  return {
    activeProgramId: parseOptionalString(document.activeProgramId),
    userExerciseConfigCount: exerciseConfigs ? Object.keys(exerciseConfigs).length : 0,
    settings,
  };
}

function parseTrainingProgram(id: string, document: Record<string, unknown> | null): TrainingProgram | null {
  if (!document) {
    return null;
  }

  const days = Array.isArray(document.days) ? document.days : [];
  return {
    id,
    name: parseOptionalString(document.name),
    color: parseOptionalString(document.color),
    icon: parseOptionalString(document.icon),
    numCycles: parseNumberLike(document.numCycles),
    runIndefinitely: parseBooleanLike(document.runIndefinitely),
    isPeriodized: parseBooleanLike(document.isPeriodized),
    dayCount: days.length,
    days,
    workoutHistoryIds: collectWorkoutHistoryIds(document.workoutCycleCompletions),
  };
}

function collectWorkoutHistoryIds(value: unknown): string[] {
  const ids = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }
      return;
    }

    const record = asRecord(node);
    if (!record) {
      return;
    }

    for (const [key, child] of Object.entries(record)) {
      if (key === 'workoutHistoryIds' && Array.isArray(child)) {
        for (const item of child) {
          const id = parseOptionalString(item);
          if (id) {
            ids.add(id);
          }
        }
        continue;
      }
      visit(child);
    }
  };

  visit(value);
  return Array.from(ids);
}

function parseWorkoutSession(document: FirestoreListedDocument): PreparedWorkoutSession {
  const source = parseWorkoutSource(document.data.workoutSource);
  const blocks = parseWorkoutBlocks(document.data.blocks);
  const startTime = parseOptionalString(document.data.startTime);
  const startTimestampMs = startTime ? parseTimestamp(startTime) : null;
  const durationMicros = parseNumberLike(document.data.duration);
  const durationSeconds = microsToSeconds(durationMicros);
  const summary = summarizeBlocks(blocks);

  return {
    startTimestampMs,
    session: {
      id: document.id,
      name: parseOptionalString(document.data.name),
      startTime,
      startTimeLocal: startTimestampMs == null ? null : formatLocalIso(startTimestampMs),
      durationMicros,
      durationSeconds,
      durationMinutes: durationSeconds == null ? null : durationSeconds / 60,
      gymId: parseOptionalString(document.data.gymId),
      gymName: parseOptionalString(document.data.gymName),
      gymIcon: parseOptionalString(document.data.gymIcon),
      source,
      summary,
      blocks,
    },
  };
}

function parseWorkoutSource(value: unknown): WorkoutSource | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    runtimeType: parseOptionalString(record.runtimeType),
    programId: parseOptionalString(record.programId),
    programName: parseOptionalString(record.programName),
    programColor: parseOptionalString(record.programColor),
    programIcon: parseOptionalString(record.programIcon),
    dayId: parseOptionalString(record.dayId),
    cycleIndex: parseNumberLike(record.cycleIndex),
  };
}

function parseWorkoutBlocks(value: unknown): WorkoutBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((block, index) => {
    const record = asRecord(block);
    const exercises = Array.isArray(record?.exercises) ? record.exercises.map(parseWorkoutExercise) : [];
    return {
      index: index + 1,
      exercises,
    };
  });
}

function parseWorkoutExercise(value: unknown): WorkoutExercise {
  const record = asRecord(value) ?? {};
  const baseWeightKg = parseNumberLike(record.baseWeight);
  return {
    id: parseOptionalString(record.id),
    exerciseId: parseOptionalString(record.exerciseId),
    note: parseOptionalString(record.note),
    baseWeightKg,
    baseWeightLb: baseWeightKg == null ? null : baseWeightKg * KG_TO_LB,
    sets: Array.isArray(record.sets) ? record.sets.map(parseWorkoutSet) : [],
  };
}

function parseWorkoutSet(value: unknown): WorkoutSet {
  const record = asRecord(value) ?? {};
  const log = asRecord(record.log);
  const target = asRecord(log?.target);
  const loggedValue = asRecord(log?.value);
  const weightKg = parseNumberLike(loggedValue?.weight);

  return {
    id: parseOptionalString(log?.id) ?? parseOptionalString(record.id),
    runtimeType: parseOptionalString(log?.runtimeType),
    setType: parseOptionalString(record.setType),
    segments: Array.isArray(record.segments) ? record.segments : [],
    target: target
      ? {
          id: parseOptionalString(target.id),
          minFullReps: parseNumberLike(target.minFullReps),
          maxFullReps: parseNumberLike(target.maxFullReps),
          rir: parseNumberLike(target.rir),
          restSeconds: microsToSeconds(parseNumberLike(target.restTimer)),
          durationSeconds: parseNumberLike(target.durationSeconds),
          distance: parseNumberLike(target.distance),
        }
      : null,
    value: loggedValue
      ? {
          fullReps: parseNumberLike(loggedValue.fullReps),
          partialReps: parseNumberLike(loggedValue.partialReps),
          rir: parseNumberLike(loggedValue.rir),
          weightKg,
          weightLb: weightKg == null ? null : weightKg * KG_TO_LB,
          restSeconds: microsToSeconds(parseNumberLike(loggedValue.restTimer)),
          durationSeconds: parseNumberLike(loggedValue.durationSeconds),
          distance: parseNumberLike(loggedValue.distance),
          isSkipped: parseBooleanLike(loggedValue.isSkipped) ?? false,
        }
      : null,
  };
}

function summarizeBlocks(blocks: WorkoutBlock[]): WorkoutSummary {
  let exerciseCount = 0;
  let setCount = 0;
  let skippedSets = 0;

  for (const block of blocks) {
    exerciseCount += block.exercises.length;
    for (const exercise of block.exercises) {
      setCount += exercise.sets.length;
      for (const set of exercise.sets) {
        if (set.value?.isSkipped) {
          skippedSets += 1;
        }
      }
    }
  }

  return {
    exerciseCount,
    setCount,
    skippedSets,
    completedSets: setCount - skippedSets,
  };
}

function summarizeWorkoutExercises(workout: WorkoutSession): string {
  const aggregates = new Map<
    string,
    {
      name: string;
      completedSets: number;
      repTotal: number;
      repCount: number;
      durationTotalSeconds: number;
      durationCount: number;
      distanceTotal: number;
      distanceCount: number;
    }
  >();
  const orderedKeys: string[] = [];

  for (const block of workout.blocks) {
    for (const exercise of block.exercises) {
      const exerciseId = exercise.exerciseId ?? exercise.id;
      const name = resolveExerciseName(exerciseId);
      if (!exerciseId) {
        continue;
      }

      if (!aggregates.has(exerciseId)) {
        aggregates.set(exerciseId, {
          name,
          completedSets: 0,
          repTotal: 0,
          repCount: 0,
          durationTotalSeconds: 0,
          durationCount: 0,
          distanceTotal: 0,
          distanceCount: 0,
        });
        orderedKeys.push(exerciseId);
      }

      const aggregate = aggregates.get(exerciseId);
      if (!aggregate) {
        continue;
      }

      for (const set of exercise.sets) {
        if (set.value?.isSkipped) {
          continue;
        }

        aggregate.completedSets += 1;

        const reps = normalizeRepCount(set.value);
        if (reps != null) {
          aggregate.repTotal += reps;
          aggregate.repCount += 1;
        }

        if (set.value?.durationSeconds != null) {
          aggregate.durationTotalSeconds += set.value.durationSeconds;
          aggregate.durationCount += 1;
        }

        if (set.value?.distance != null) {
          aggregate.distanceTotal += set.value.distance;
          aggregate.distanceCount += 1;
        }
      }
    }
  }

  return orderedKeys
    .map(key => aggregates.get(key))
    .filter((aggregate): aggregate is NonNullable<typeof aggregate> => aggregate != null && aggregate.completedSets > 0)
    .map(formatExerciseSummary)
    .join('; ');
}

function normalizeRepCount(value: WorkoutSetValue | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const fullReps = value.fullReps ?? 0;
  const partialReps = value.partialReps ?? 0;
  const reps = fullReps + partialReps;
  return reps > 0 ? reps : null;
}

function resolveExerciseName(exerciseId: string | null): string {
  if (!exerciseId) {
    return 'Unknown Exercise';
  }
  return WORKOUTS_EXERCISE_NAME_BY_ID[exerciseId] ?? exerciseId;
}

function formatExerciseSummary(aggregate: {
  name: string;
  completedSets: number;
  repTotal: number;
  repCount: number;
  durationTotalSeconds: number;
  durationCount: number;
  distanceTotal: number;
  distanceCount: number;
}): string {
  if (aggregate.repCount > 0) {
    return `${aggregate.name} ${aggregate.completedSets} x ${Math.round(aggregate.repTotal / aggregate.repCount)}`;
  }
  if (aggregate.durationCount > 0) {
    return `${aggregate.name} ${aggregate.completedSets} x ${Math.round(aggregate.durationTotalSeconds / aggregate.durationCount)}s`;
  }
  if (aggregate.distanceCount > 0) {
    return `${aggregate.name} ${aggregate.completedSets} x ${Math.round(aggregate.distanceTotal / aggregate.distanceCount)}`;
  }
  return `${aggregate.name} ${aggregate.completedSets} sets`;
}

function resolveWindow(options: {
  days: number;
  start?: string;
  end?: string;
  nowUnixSeconds?: number;
}): ResolvedWindow {
  if (!Number.isFinite(options.days) || options.days <= 0) {
    throw new Error('--days must be a positive number.');
  }

  const nowUnixSeconds = options.nowUnixSeconds ?? Date.now() / 1000;
  const endUnixSeconds = options.end ? parseDateArg(options.end, 'end') : nowUnixSeconds;
  const startUnixSeconds = options.start
    ? parseDateArg(options.start, 'start')
    : endUnixSeconds - options.days * SECONDS_PER_DAY;

  if (startUnixSeconds > endUnixSeconds) {
    throw new Error('Start date must be before end date.');
  }

  return { startUnixSeconds, endUnixSeconds };
}

function parseDateArg(value: string, label: string): number {
  const localDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (localDateMatch) {
    const year = Number(localDateMatch[1]);
    const month = Number(localDateMatch[2]);
    const day = Number(localDateMatch[3]);
    const timestamp = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Invalid ${label} date: ${value}`);
    }
    return timestamp / 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${label} date: ${value}`);
  }
  return timestamp / 1000;
}

function parseMacrofactorCredentials(value: string | undefined): { email: string; password: string } {
  const raw = value?.trim();
  if (!raw) {
    throw new Error('MACROFACTOR_CREDENTIALS is not set. Expected <email>:<password>.');
  }

  const separatorIndex = raw.indexOf(':');
  if (separatorIndex === -1) {
    throw new Error('MACROFACTOR_CREDENTIALS must use the format <email>:<password>.');
  }

  const email = raw.slice(0, separatorIndex).trim();
  const password = raw.slice(separatorIndex + 1);
  if (!email || !password) {
    throw new Error('MACROFACTOR_CREDENTIALS must include both a non-empty email and password.');
  }

  return { email, password };
}

function toIso(unixSeconds: number): string {
  return formatLocalIso(unixSeconds * 1000);
}

function getDateTimeParts(value: string | null, dateFormat: ConciseDateFormat): { date: string; time: string } {
  const timestamp = value ? parseTimestamp(value) : Number.NaN;
  if (Number.isNaN(timestamp)) {
    return { date: '', time: '' };
  }
  return {
    date: formatDate(timestamp, dateFormat),
    time: formatTime(timestamp),
  };
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function formatDate(timestamp: number, format: ConciseDateFormat): string {
  const d = new Date(timestamp);
  if (format === 'iso') {
    return formatLocalDateKey(d);
  }
  if (format === 'csv') {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${dd}.${mm}.${yyyy}`;
  }
  const weekday = WEEKDAYS_SHORT[d.getDay()] ?? '';
  const month = MONTHS_LONG[d.getMonth()] ?? '';
  const day = formatOrdinal(d.getDate());
  return `${weekday} ${month} ${day}`.trim();
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(timestamp));
}

function formatOrdinal(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  const abs = Math.abs(Math.trunc(value));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${abs}th`;
  }
  const mod10 = abs % 10;
  const suffix = mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th';
  return `${abs}${suffix}`;
}

function formatLocalIso(timestamp: number): string {
  const d = new Date(timestamp);
  const year = String(d.getFullYear());
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function formatLocalDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseTimestamp(value: string): number {
  return Date.parse(value);
}

function microsToSeconds(value: number | null): number | null {
  if (value == null) {
    return null;
  }
  return value / MICROS_PER_SECOND;
}

function parseFirestoreValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const typedValue = value as Record<string, unknown>;
  if ('stringValue' in typedValue) {
    return typedValue.stringValue ?? null;
  }
  if ('integerValue' in typedValue) {
    return parseNumberLike(typedValue.integerValue) ?? typedValue.integerValue ?? null;
  }
  if ('doubleValue' in typedValue) {
    return parseNumberLike(typedValue.doubleValue) ?? typedValue.doubleValue ?? null;
  }
  if ('booleanValue' in typedValue) {
    return Boolean(typedValue.booleanValue);
  }
  if ('nullValue' in typedValue) {
    return null;
  }
  if ('timestampValue' in typedValue) {
    return typedValue.timestampValue ?? null;
  }
  if ('referenceValue' in typedValue) {
    return typedValue.referenceValue ?? null;
  }
  if ('geoPointValue' in typedValue) {
    return typedValue.geoPointValue ?? null;
  }
  if ('bytesValue' in typedValue) {
    return typedValue.bytesValue ?? null;
  }
  if ('mapValue' in typedValue) {
    const mapValue = typedValue.mapValue;
    if (mapValue && typeof mapValue === 'object' && !Array.isArray(mapValue)) {
      return parseFirestoreFields((mapValue as { fields?: unknown }).fields);
    }
    return {};
  }
  if ('arrayValue' in typedValue) {
    const arrayValue = typedValue.arrayValue;
    if (!arrayValue || typeof arrayValue !== 'object' || Array.isArray(arrayValue)) {
      return [];
    }
    const values = (arrayValue as { values?: unknown }).values;
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map(parseFirestoreValue);
  }
  return typedValue;
}

function parseFirestoreFields(fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = parseFirestoreValue(value);
  }
  return result;
}

function extractDocumentId(name: string | undefined): string | null {
  if (!name) {
    return null;
  }
  const id = name.split('/').at(-1)?.trim();
  return id || null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseBooleanLike(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

class WorkoutsApiClient {
  private constructor(private readonly session: FirebaseSession) {}

  static async login(email: string, password: string): Promise<WorkoutsApiClient> {
    const errors: string[] = [];

    for (const authConfig of FIREBASE_AUTH_CONFIGS) {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${authConfig.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Ios-Bundle-Identifier': authConfig.bundleId,
          },
          body: JSON.stringify({
            email,
            password,
            returnSecureToken: true,
          }),
        }
      );

      if (!response.ok) {
        errors.push(`${authConfig.label}: ${await formatError(response)}`);
        continue;
      }

      const data = (await response.json()) as FirebaseSignInResponse;
      if (!data.idToken || !data.refreshToken || !data.expiresIn || !data.localId) {
        errors.push(`${authConfig.label}: sign-in response was missing required auth fields.`);
        continue;
      }

      return new WorkoutsApiClient({
        authConfig,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresAtMs: Date.now() + Number(data.expiresIn) * 1000,
        userId: data.localId,
      });
    }

    throw new Error(`Workouts sign-in failed.\n${errors.join('\n')}`);
  }

  async getUserDocument(pathSuffix: string, errorLabel: string): Promise<Record<string, unknown> | null> {
    const token = await this.getIdToken();
    const response = await fetch(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/${pathSuffix}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`${errorLabel}: ${await formatError(response)}`);
    }

    const document = (await response.json()) as FirestoreDocumentResponse;
    return parseFirestoreFields(document.fields);
  }

  async listUserCollection(
    pathSuffix: string,
    errorLabel: string,
    pageSize = WORKOUT_HISTORY_PAGE_SIZE
  ): Promise<FirestoreListedDocument[]> {
    const documents: FirestoreListedDocument[] = [];
    let pageToken: string | undefined;

    do {
      const token = await this.getIdToken();
      const url = new URL(`${FIRESTORE_BASE_URL}/users/${this.session.userId}/${pathSuffix}`);
      url.searchParams.set('pageSize', String(pageSize));
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.status === 404) {
        return [];
      }
      if (!response.ok) {
        throw new Error(`${errorLabel}: ${await formatError(response)}`);
      }

      const data = (await response.json()) as FirestoreListDocumentsResponse;
      const batch = Array.isArray(data.documents) ? data.documents : [];
      for (const document of batch) {
        const id = extractDocumentId(document.name);
        if (!id) {
          continue;
        }
        documents.push({
          id,
          data: parseFirestoreFields(document.fields),
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return documents;
  }

  async createTrainingProgram(
    id: string,
    program: ProgramDefinition,
    activate: boolean
  ): Promise<void> {
    const token = await this.getIdToken();
    const userDocumentPath = `${FIRESTORE_DOCUMENTS_PATH}/users/${this.session.userId}`;
    const writes: Record<string, unknown>[] = [
      {
        update: {
          name: `${userDocumentPath}/trainingProgram/${id}`,
          fields: serializeFirestoreFields(program),
        },
        currentDocument: { exists: false },
      },
    ];

    if (activate) {
      writes.push({
        update: {
          name: `${userDocumentPath}/profiles/workout`,
          fields: {
            activeProgramId: { stringValue: id },
          },
        },
        updateMask: { fieldPaths: ['activeProgramId'] },
        currentDocument: { exists: true },
      });
    }

    const response = await fetch(`${FIRESTORE_BASE_URL}:commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    });

    if (!response.ok) {
      throw new Error(`Workouts program creation failed: ${await formatError(response)}`);
    }
  }

  private async getIdToken(): Promise<string> {
    if (this.session.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.session.idToken;
    }

    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${this.session.authConfig.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Ios-Bundle-Identifier': this.session.authConfig.bundleId,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.session.refreshToken,
        }).toString(),
      }
    );

    if (!response.ok) {
      throw new Error(`Workouts token refresh failed: ${await formatError(response)}`);
    }

    const data = (await response.json()) as FirebaseRefreshResponse;
    if (!data.id_token || !data.refresh_token || !data.expires_in) {
      throw new Error('Workouts token refresh response was missing required auth fields.');
    }

    this.session.idToken = data.id_token;
    this.session.refreshToken = data.refresh_token;
    this.session.expiresAtMs = Date.now() + Number(data.expires_in) * 1000;
    return this.session.idToken;
  }
}

async function formatError(response: Response): Promise<string> {
  const body = await response.text();
  const snippet = body.trim().slice(0, 500);
  return `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ''}`;
}
