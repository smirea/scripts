import { expect, mock, test } from 'bun:test';

mock.module('./env', () => ({ default: {} }));
const { buildTrainingProgramDocument, parseProgramDefinition } = await import('./workouts');

const set = { reps: [8, 12], restSeconds: 75 };
const program = {
  name: 'Fixture',
  days: [
    { name: 'A', exercises: [{ name: 'Press', exerciseId: 'press-id', notes: 'add 5 lb at 12 reps', sets: [set, set] }] },
    {
      name: 'B',
      blocks: [{ exercises: [
        { name: 'Row', exerciseId: 'row-id', sets: [{ reps: [10, 10], restSeconds: 0 }] },
        { name: 'Curl', exerciseId: 'curl-id', sets: [{ reps: [6, 8], restSeconds: 90 }] },
      ] }],
    },
  ],
};

test('a program serializes to the Workouts app schema: one block per straight set, a superset in one block, rest in microseconds, notes keyed by program exercise id', () => {
  const document = buildTrainingProgramDocument(parseProgramDefinition(program), 'program-id');
  expect(document).toMatchObject({ id: 'program-id', deload: null, expanded: false });
  const days = document.days as any[];
  expect(days.map(day => day.blocks.map((block: any) => block.exercises.map((exercise: any) => exercise.exerciseId))))
    .toEqual([[['press-id']], [['row-id', 'curl-id']]]);

  const press = days[0].blocks[0].exercises[0];
  expect(press).not.toHaveProperty('note');
  expect(press.periodizedTargets).toMatchObject({ runtimeType: 'simple', deload: null, value: { isSkipped: false, overrideRestTimers: true } });
  expect(press.periodizedTargets.value.sets).toEqual(Array(2).fill({
    setType: 'standard',
    log: { minFullReps: 8, maxFullReps: 12, rir: null, restTimer: 75_000_000, durationSeconds: null, distance: null },
  }));
  expect(document.programExerciseIdToNote).toEqual({ [press.id]: { note: 'add 5 lb at 12 reps', updatedAt: document.updatedAt } });

  const [row, curl] = days[1].blocks[0].exercises;
  expect(row.periodizedTargets.value.sets[0].log).toMatchObject({ minFullReps: 10, maxFullReps: 10, restTimer: 0 });
  expect(curl.periodizedTargets.value.sets[0].log).toMatchObject({ minFullReps: 6, maxFullReps: 8, restTimer: 90_000_000 });
});

test('a day with both exercises and blocks, or with an empty block, is rejected', () => {
  for (const day of [
    { name: 'A', exercises: [], blocks: [] },
    { name: 'A', blocks: [{ exercises: [] }] },
  ]) {
    expect(() => parseProgramDefinition({ name: 'Invalid', days: [day] })).toThrow();
  }
});
