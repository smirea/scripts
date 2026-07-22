import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Database } from 'bun:sqlite';
import { ClassicLevel } from 'classic-level';
import { parse } from 'protobufjs';

const KG_TO_LB = 2.2046226218;
const FIRESTORE_PROJECT_ID = 'sbs-diet-app';
const HELPER_PACKAGE_PATH = path.join(import.meta.dir, 'workoutsQueueHelper');
const HELPER_BUILD_PATH = path.resolve(import.meta.dir, '..', 'out', 'workouts-queue-build');
const WORKOUTS_STORE_SUFFIX = path.join(
  'Data',
  'Library',
  'Application Support',
  'com.sbs.train',
  'stores',
  'workout.db'
);
const FIRESTORE_STORE_SUFFIX = path.join(
  'Data',
  'Library',
  'Application Support',
  'firestore',
  '__FIRAPP_DEFAULT',
  'sbs-diet-app',
  'main'
);
const FIRESTORE_PROTO = `
  syntax = "proto3";
  message MaybeDocument {
    Document document = 2;
    bool has_committed_mutations = 3;
  }
  message Document {
    string name = 1;
    repeated FieldsEntry fields = 2;
    Timestamp create_time = 3;
    Timestamp update_time = 4;
  }
  message FieldsEntry {
    string key = 1;
    Value value = 2;
  }
  message Value {
    oneof value_type {
      bool boolean_value = 1;
      int64 integer_value = 2;
      double double_value = 3;
      string reference_value = 5;
      MapValue map_value = 6;
      GeoPoint geo_point = 8;
      ArrayValue array_value = 9;
      Timestamp timestamp_value = 10;
      int32 null_value = 11;
      string string_value = 17;
      bytes bytes_value = 18;
    }
  }
  message MapValue { repeated FieldsEntry fields = 1; }
  message ArrayValue { repeated Value values = 1; }
  message Timestamp { int64 seconds = 1; int32 nanos = 2; }
  message GeoPoint { double latitude = 1; double longitude = 2; }
`;
const MAYBE_DOCUMENT = parse(FIRESTORE_PROTO, { keepCase: true }).root.lookupType('MaybeDocument');

export interface LocalFirestoreDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface LocalWorkoutsSnapshot {
  userId: string;
  profile: Record<string, unknown> | null;
  programs: LocalFirestoreDocument[];
  history: LocalFirestoreDocument[];
}

export interface LoggedSetDefinition {
  reps: number;
  weightLb?: number | null;
  rir?: number | null;
}

export interface LoggedExerciseDefinition {
  name?: string;
  sets: LoggedSetDefinition[];
}

export interface LoggedWorkoutDefinition {
  name: string;
  startTime?: string;
  durationMinutes?: number;
  exercises: LoggedExerciseDefinition[];
}

export interface WorkoutLogDefinition {
  program: string;
  workouts: LoggedWorkoutDefinition[];
}

interface CachedDocument {
  name: string;
  id: string;
  data: Record<string, unknown>;
}

export async function readLocalWorkoutsSnapshot(): Promise<LocalWorkoutsSnapshot> {
  const stores = resolveWorkoutsStores();
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'workouts-cache-'));
  const firestorePath = path.join(temporaryRoot, 'main');
  cpSync(stores.firestorePath, firestorePath, { recursive: true });
  const db = openFirestore(firestorePath);
  try {
    const documents = await readCachedDocuments(db);
    const profile = documents.find(document => document.name.endsWith('/profiles/workout'));
    const userId = profile?.name.split('/users/')[1]?.split('/')[0];
    if (!userId) {
      throw new Error('The cached Workouts user was not found. Open Workouts once, then try again.');
    }
    return {
      userId,
      profile: profile.data,
      programs: documents
        .filter(document => document.name.includes('/trainingProgram/'))
        .map(({ id, data }) => ({ id, data })),
      history: documents
        .filter(document => document.name.includes('/workoutHistory/'))
        .map(({ id, data }) => ({ id, data })),
    };
  } finally {
    await db.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function logWorkouts(
  definition: WorkoutLogDefinition,
  options: { activate: boolean; dryRun: boolean }
): Promise<{ programId: string; workoutIds: string[]; backupPath: string | null }> {
  assertWorkoutsIsClosed();
  const stores = resolveWorkoutsStores();
  const snapshot = await readLocalWorkoutsSnapshot();
  if (!snapshot.profile) {
    throw new Error('The cached Workouts profile was not found. Open Workouts once, then try again.');
  }
  const program = snapshot.programs.find(
    document =>
      typeof document.data.name === 'string' &&
      document.data.name.toLowerCase() === definition.program.toLowerCase()
  );
  if (!program) {
    throw new Error(`Program "${definition.program}" was not found in the local Workouts cache.`);
  }
  const historyTemplate = snapshot.history[0];
  if (!historyTemplate) {
    throw new Error('No cached workout history is available to initialize workout entries.');
  }

  const workouts = buildLoggedWorkouts(program, historyTemplate, definition.workouts);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(workouts.map(workout => workout.data), null, 2)}\n`);
    return { programId: program.id, workoutIds: workouts.map(workout => workout.id), backupPath: null };
  }

  const backupPath = backupWorkoutsStores(stores);
  const priorHistoryIds = Array.isArray(program.data.workoutHistoryIds)
    ? program.data.workoutHistoryIds.filter((value): value is string => typeof value === 'string')
    : [];
  const writes: Array<{ path: string; merge: boolean; data: Record<string, unknown> }> = [];
  if (options.activate) {
    writes.push({
      path: `users/${snapshot.userId}/profiles/workout`,
      merge: true,
      data: { activeProgramId: program.id },
    });
  }
  writes.push({
    path: `users/${snapshot.userId}/trainingProgram/${program.id}`,
    merge: true,
    data: { workoutHistoryIds: [...new Set([...priorHistoryIds, ...workouts.map(workout => workout.id)])] },
  });
  for (const workout of workouts) {
    writes.push({
      path: `users/${snapshot.userId}/workoutHistory/${workout.id}`,
      merge: false,
      data: workout.data,
    });
  }

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'workouts-writes-'));
  const operationsPath = path.join(temporaryRoot, 'operations.json');
  try {
    writeFileSync(operationsPath, JSON.stringify({ writes }));
    queueFirestoreWrites(stores.firestorePath, snapshot.userId, operationsPath);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  updateSiriWorkoutStore(stores.sqlitePath, program.id, workouts, options.activate);
  Bun.spawnSync({ cmd: ['open', '-a', 'Workouts'], stdout: 'ignore', stderr: 'ignore' });
  return { programId: program.id, workoutIds: workouts.map(workout => workout.id), backupPath };
}

function resolveWorkoutsStores(): { sqlitePath: string; firestorePath: string } {
  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  const containersPath = path.join(home, 'Library', 'Containers');
  const container = readdirSync(containersPath).find(entry =>
    existsSync(path.join(containersPath, entry, WORKOUTS_STORE_SUFFIX))
  );
  if (!container) {
    throw new Error('The Workouts local data store was not found.');
  }

  const root = path.join(containersPath, container);
  return {
    sqlitePath: path.join(root, WORKOUTS_STORE_SUFFIX),
    firestorePath: path.join(root, FIRESTORE_STORE_SUFFIX),
  };
}

function assertWorkoutsIsClosed(): void {
  const result = Bun.spawnSync({
    cmd: ['pgrep', '-f', '/Wrapper/Runner.app/Runner'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (result.exitCode === 0) {
    throw new Error('Quit the Workouts app before changing its local workout data.');
  }
}

function openFirestore(storePath: string): ClassicLevel<Buffer, Buffer> {
  return new ClassicLevel<Buffer, Buffer>(storePath, {
    createIfMissing: false,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });
}

async function readCachedDocuments(db: ClassicLevel<Buffer, Buffer>): Promise<CachedDocument[]> {
  const documents: CachedDocument[] = [];
  for await (const [key, encoded] of db.iterator()) {
    const keyText = key.toString('utf8');
    if (!keyText.includes('remote_document') || keyText.includes('remote_document_read_time')) {
      continue;
    }

    const wrapper = MAYBE_DOCUMENT.toObject(MAYBE_DOCUMENT.decode(encoded), {
      longs: Number,
      bytes: Buffer,
    }) as Record<string, unknown>;
    const document = asRecord(wrapper.document);
    const name = typeof document?.name === 'string' ? document.name : null;
    if (!document || !name) {
      continue;
    }

    documents.push({
      name,
      id: name.split('/').at(-1) ?? name,
      data: decodeFirestoreFields(document.fields),
    });
  }
  return documents;
}

function buildLoggedWorkouts(
  program: LocalFirestoreDocument,
  historyTemplate: LocalFirestoreDocument,
  definitions: LoggedWorkoutDefinition[]
): LocalFirestoreDocument[] {
  const days = Array.isArray(program.data.days) ? program.data.days : [];
  const color = typeof program.data.color === 'string' ? program.data.color : 'yellow';
  const icon = typeof program.data.icon === 'string' ? program.data.icon : 'extension';
  const templateGym = {
    gymId: historyTemplate.data.gymId ?? null,
    gymName: historyTemplate.data.gymName ?? null,
    gymIcon: historyTemplate.data.gymIcon ?? null,
  };

  return definitions.map((definition, workoutIndex) => {
    const day = days.find(value => asRecord(value)?.name === definition.name);
    const dayRecord = asRecord(day);
    if (!dayRecord) {
      throw new Error(`Workout "${definition.name}" was not found in program "${program.data.name}".`);
    }

    const programExercises = collectProgramExercises(dayRecord);
    if (programExercises.length !== definition.exercises.length) {
      throw new Error(
        `${definition.name} has ${programExercises.length} program exercises but ${definition.exercises.length} logged exercises.`
      );
    }

    let exerciseOffset = 0;
    const blocks = (Array.isArray(dayRecord.blocks) ? dayRecord.blocks : []).map(blockValue => {
      const block = asRecord(blockValue) ?? {};
      const exercises = (Array.isArray(block.exercises) ? block.exercises : []).map(exerciseValue => {
        const exercise = asRecord(exerciseValue) ?? {};
        const loggedExercise = definition.exercises[exerciseOffset++];
        return buildLoggedExercise(exercise, loggedExercise, definition.name);
      });
      return { id: crypto.randomUUID(), exercises };
    });

    const id = crypto.randomUUID();
    const startTime = definition.startTime
      ? new Date(definition.startTime).toISOString()
      : new Date(Date.now() - (definitions.length - workoutIndex - 1) * 86_400_000).toISOString();
    const exerciseIds = programExercises
      .map(exercise => exercise.exerciseId)
      .filter((value): value is string => typeof value === 'string');
    const data: Record<string, unknown> = {
      blocks,
      distanceUnitByExerciseId: Object.fromEntries(exerciseIds.map(exerciseId => [exerciseId, 'i'])),
      duration: Math.round((definition.durationMinutes ?? 60) * 60 * 1_000_000),
      ...templateGym,
      id,
      name: definition.name,
      startTime,
      weightUnitByExerciseId: Object.fromEntries(exerciseIds.map(exerciseId => [exerciseId, 'lbs'])),
      workoutSource: {
        cycleIndex: 0,
        dayId: dayRecord.id,
        programColor: color,
        programIcon: icon,
        programId: program.id,
        programName: program.data.name,
        runtimeType: 'program',
      },
    };
    return {
      id,
      data,
    };
  });
}

function collectProgramExercises(day: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(day.blocks) ? day.blocks : []).flatMap(blockValue => {
    const block = asRecord(blockValue);
    return Array.isArray(block?.exercises)
      ? block.exercises.map(value => asRecord(value) ?? {})
      : [];
  });
}

function buildLoggedExercise(
  programExercise: Record<string, unknown>,
  loggedExercise: LoggedExerciseDefinition,
  workoutName: string
): Record<string, unknown> {
  const targets = asRecord(programExercise.periodizedTargets);
  const targetValue = asRecord(targets?.value);
  const programSets = Array.isArray(targetValue?.sets) ? targetValue.sets : [];
  if (loggedExercise.sets.length > programSets.length) {
    const label = loggedExercise.name ?? String(programExercise.exerciseId ?? 'exercise');
    throw new Error(
      `${workoutName}: ${label} has ${programSets.length} program sets but ${loggedExercise.sets.length} logged sets.`
    );
  }

  return {
    baseWeight: null,
    exerciseId: programExercise.exerciseId,
    id: crypto.randomUUID(),
    note: '',
    sets: loggedExercise.sets.map((loggedSet, index) => {
      const setValue = programSets[index];
      const set = asRecord(setValue) ?? {};
      const target = asRecord(set.log) ?? {};
      return {
        log: {
          id: crypto.randomUUID(),
          runtimeType: 'single',
          target,
          value: {
            distance: null,
            durationSeconds: null,
            fullReps: loggedSet.reps,
            isSkipped: false,
            partialReps: null,
            restTimer: target.restTimer ?? null,
            rir: loggedSet.rir ?? null,
            weight: loggedSet.weightLb == null ? null : loggedSet.weightLb / KG_TO_LB,
          },
        },
        setType: set.setType,
      };
    }),
  };
}

function decodeFirestoreFields(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    value.flatMap(entry => {
      const record = asRecord(entry);
      return typeof record?.key === 'string' ? [[record.key, decodeFirestoreValue(record.value)]] : [];
    })
  );
}

function decodeFirestoreValue(value: unknown): unknown {
  const record = asRecord(value) ?? {};
  if ('string_value' in record) return record.string_value;
  if ('boolean_value' in record) return record.boolean_value;
  if ('integer_value' in record) return Number(record.integer_value);
  if ('double_value' in record) return record.double_value;
  if ('null_value' in record) return null;
  if ('reference_value' in record) return record.reference_value;
  if ('bytes_value' in record) return record.bytes_value;

  const mapValue = asRecord(record.map_value);
  if (mapValue) return decodeFirestoreFields(mapValue.fields);
  const arrayValue = asRecord(record.array_value);
  if (Array.isArray(arrayValue?.values)) return arrayValue.values.map(decodeFirestoreValue);
  const timestamp = asRecord(record.timestamp_value);
  if (timestamp) {
    return new Date(Number(timestamp.seconds) * 1000 + Number(timestamp.nanos ?? 0) / 1_000_000).toISOString();
  }
  return undefined;
}

function queueFirestoreWrites(firestorePath: string, userId: string, operationsPath: string): void {
  const build = Bun.spawnSync({
    cmd: [
      'swift',
      'build',
      '-c',
      'release',
      '--package-path',
      HELPER_PACKAGE_PATH,
      '--scratch-path',
      HELPER_BUILD_PATH,
      '--product',
      'Queue',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(`Could not build the Workouts queue helper.\n${build.stderr.toString().trim()}`);
  }

  const binaryPathResult = Bun.spawnSync({
    cmd: [
      'swift',
      'build',
      '-c',
      'release',
      '--package-path',
      HELPER_PACKAGE_PATH,
      '--scratch-path',
      HELPER_BUILD_PATH,
      '--show-bin-path',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (binaryPathResult.exitCode !== 0) {
    throw new Error(`Could not locate the Workouts queue helper.\n${binaryPathResult.stderr.toString().trim()}`);
  }

  const home = process.env.HOME;
  if (!home) {
    throw new Error('HOME is not set.');
  }
  const helperRoot = path.join(home, 'Library', 'Application Support', 'firestore');
  const helperAppPath = path.join(helperRoot, '__FIRAPP_DEFAULT');
  const helperProjectPath = path.join(helperAppPath, FIRESTORE_PROJECT_ID);
  const helperFirestorePath = path.join(helperProjectPath, 'main');
  if (existsSync(helperFirestorePath)) {
    throw new Error(`The queue helper path already exists: ${helperFirestorePath}`);
  }

  const createdDirectories = [helperRoot, helperAppPath, helperProjectPath].filter(value => !existsSync(value));
  mkdirSync(helperProjectPath, { recursive: true });
  symlinkSync(firestorePath, helperFirestorePath, 'dir');
  try {
    const binaryPath = path.join(binaryPathResult.stdout.toString().trim(), 'Queue');
    const queued = Bun.spawnSync({
      cmd: [binaryPath, userId, operationsPath],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (queued.exitCode !== 0) {
      throw new Error(`Could not queue Workouts changes.\n${queued.stderr.toString().trim()}`);
    }
  } finally {
    if (existsSync(helperFirestorePath)) unlinkSync(helperFirestorePath);
    for (const directory of createdDirectories.toReversed()) {
      try {
        rmdirSync(directory);
      } catch {}
    }
  }
}

function backupWorkoutsStores(stores: { sqlitePath: string; firestorePath: string }): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.resolve('out', `workouts-backup-${stamp}`);
  mkdirSync(backupPath, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${stores.sqlitePath}${suffix}`;
    if (existsSync(source)) cpSync(source, path.join(backupPath, `workout.db${suffix}`));
  }
  cpSync(stores.firestorePath, path.join(backupPath, 'firestore'), { recursive: true });
  return backupPath;
}

function updateSiriWorkoutStore(
  sqlitePath: string,
  programId: string,
  workouts: LocalFirestoreDocument[],
  activate: boolean
): void {
  const db = new Database(sqlitePath);
  try {
    db.transaction(() => {
      if (activate) {
        db.query('UPDATE siriProgram SET isActiveProgram = NULL').run();
        db.query('UPDATE siriProgram SET isActiveProgram = ? WHERE id = ?').run(
          formatSqliteDate(new Date()),
          programId
        );
      }
      const updateWorkout = db.query(
        'UPDATE siriWorkout SET didCompleteThisCycle = 1, lastCompleted = ? WHERE programId = ? AND name = ?'
      );
      for (const workout of workouts) {
        updateWorkout.run(
          formatSqliteDate(new Date(String(workout.data.startTime))),
          programId,
          String(workout.data.name)
        );
      }
    })();
  } finally {
    db.close();
  }
}

function formatSqliteDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
