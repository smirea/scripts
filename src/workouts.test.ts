import { expect, mock, test } from 'bun:test';
import program from '../programs/3-day-upper.json';

mock.module('./env', () => ({ default: {} }));
const { buildTrainingProgramDocument, parseProgramDefinition } = await import('./workouts');

test('upper program preserves straight sets, native superset, and rest targets', () => {
  const document = buildTrainingProgramDocument(parseProgramDefinition(program), 'test-program');
  const days = document.days as Array<{
    blocks: Array<{ exercises: Array<{
      periodizedTargets: { value: {
        overrideRestTimers: boolean;
        sets: Array<{ log: { minFullReps: number; maxFullReps: number; restTimer: number } }>;
      } };
    }> }>;
  }>;
  expect(days.map(day => day.blocks.map(block => block.exercises.length))).toEqual([
    [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 2],
  ]);
  for (const [dayIndex, day] of days.entries()) {
    for (const [blockIndex, block] of day.blocks.entries()) {
      for (const [exerciseIndex, exercise] of block.exercises.entries()) {
        const targets = exercise.periodizedTargets.value;
        expect(targets.overrideRestTimers).toBe(true);
        expect(targets.sets).toHaveLength(3);
        for (const set of targets.sets) {
          expect(set.log.minFullReps).toBe(8);
          expect(set.log.maxFullReps).toBe(12);
          expect(set.log.restTimer).toBe(
            dayIndex === 2 && blockIndex === 3 && exerciseIndex === 0 ? 0 : 75_000_000
          );
        }
      }
    }
  }
});

test('rejects ambiguous or empty program blocks', () => {
  for (const day of [
    { name: 'A', exercises: [], blocks: [] },
    { name: 'A', blocks: [{ exercises: [] }] },
  ]) {
    expect(() => parseProgramDefinition({ name: 'Invalid', days: [day] })).toThrow();
  }
});

test('serializes the native app schema instead of display labels', () => {
  const document = buildTrainingProgramDocument(parseProgramDefinition(program), 'test-program');
  expect(document).toMatchObject({ deload: null, expanded: false });
  const days = document.days as any[];
  const notes = document.programExerciseIdToNote as Record<string, { note: string; updatedAt: string }>;
  for (const day of days) {
    expect(day.gymId).toBeNull();
    for (const block of day.blocks) {
      for (const exercise of block.exercises) {
        expect(exercise).not.toHaveProperty('note');
        expect(notes[exercise.id]?.note).toContain('add 5 lb');
        expect(notes[exercise.id]?.updatedAt).toBe(document.updatedAt as string);
        expect(exercise.periodizedTargets.deload).toBeNull();
        expect(exercise.periodizedTargets.value.isSkipped).toBe(false);
        for (const set of exercise.periodizedTargets.value.sets) {
          expect(set.setType).toBe('standard');
          expect(set.log).not.toHaveProperty('id');
        }
      }
    }
  }
});
