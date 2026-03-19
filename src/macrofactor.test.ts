import { describe, expect, it } from 'bun:test';

import { renderCsv, renderCsvRecords, serializeReport, toConciseRows, toFullRows } from './macrofactor-report';
import { parseFirestoreFields } from './utils/macrofactorApi';
import {
  buildMacrofactorApiReport,
  parseFoodLogTimestamp,
  parseMacrofactorCredentials,
} from './macrofactor';

function toEntryId(iso: string): string {
  return String(Date.parse(iso) * 1000);
}

describe('parseMacrofactorCredentials', () => {
  it('parses email and password and preserves colons in the password', () => {
    expect(parseMacrofactorCredentials('user@example.com:abc:def')).toEqual({
      email: 'user@example.com',
      password: 'abc:def',
    });
  });

  it('rejects missing or malformed credentials', () => {
    expect(() => parseMacrofactorCredentials(undefined)).toThrow('MACROFACTOR_CREDENTIALS is not set');
    expect(() => parseMacrofactorCredentials('user@example.com')).toThrow('format <email>:<password>');
    expect(() => parseMacrofactorCredentials(':secret')).toThrow('non-empty email and password');
  });
});

describe('parseFirestoreFields', () => {
  it('parses nested Firestore typed values', () => {
    expect(
      parseFirestoreFields({
        name: { stringValue: 'Chicken' },
        count: { integerValue: '3' },
        score: { doubleValue: 1.5 },
        ok: { booleanValue: true },
        nested: {
          mapValue: {
            fields: {
              child: { stringValue: 'value' },
            },
          },
        },
        list: {
          arrayValue: {
            values: [{ stringValue: 'a' }, { nullValue: null }, { integerValue: '2' }],
          },
        },
      })
    ).toEqual({
      name: 'Chicken',
      count: 3,
      score: 1.5,
      ok: true,
      nested: { child: 'value' },
      list: ['a', null, 2],
    });
  });
});

describe('parseFoodLogTimestamp', () => {
  it('prefers the Firestore entry id timestamp', () => {
    const timestampMs = Date.parse('2026-02-07T10:00:00.000Z');
    expect(parseFoodLogTimestamp(String(timestampMs * 1000))).toBe(timestampMs);
  });

  it('falls back to the document date and time when needed', () => {
    expect(parseFoodLogTimestamp('entry', '2026-02-07', '5', '30')).toBe(Date.parse('2026-02-07T05:30:00.000Z'));
  });
});

describe('buildMacrofactorApiReport', () => {
  it('groups by food id, skips deleted rows, scales macros, and preserves CSV output', () => {
    const report = buildMacrofactorApiReport({
      sourcePath: 'api://macrofactor/food-log',
      days: 7,
      start: '2026-02-05T00:00:00.000Z',
      end: '2026-02-08T00:00:00.000Z',
      dayDocuments: [
        {
          date: '2026-02-06',
          document: {
            [toEntryId('2026-02-06T09:00:00.000Z')]: {
              id: 'food-a',
              t: 'Alpha, Food',
              b: 'Alpha Brand',
              c: '90',
              p: '8',
              e: '18',
              f: '4',
              g: '100',
              w: '100',
              y: '1',
              q: '1',
              s: 'serving',
              k: 't',
              m: [{ m: 'serving', q: '1', w: '100' }],
              291: '2',
            },
            [toEntryId('2026-02-06T08:30:00.000Z')]: {
              id: 'food-b',
              t: 'Beta Food',
              b: 'Quick Add',
              c: '120',
              p: '12',
              e: '15',
              f: '3',
              g: '80',
              w: '40',
              y: '2',
              q: '1',
              s: 'wrap',
              k: 'n',
              291: '2',
              269: '1',
            },
          },
        },
        {
          date: '2026-02-07',
          document: {
            [toEntryId('2026-02-07T10:00:00.000Z')]: {
              id: 'food-a',
              t: 'Alpha, Food',
              b: 'Alpha Brand',
              c: '100',
              p: '10',
              e: '20',
              f: '5',
              g: '100',
              w: '100',
              y: '1.5',
              q: '1',
              s: 'serving',
              k: 't',
              m: [{ m: 'serving', q: '1', w: '100' }],
              291: '4',
              269: '3',
            },
            [toEntryId('2026-02-07T11:00:00.000Z')]: {
              id: 'food-c',
              t: 'Deleted Food',
              c: '200',
              d: true,
              g: '100',
              w: '100',
              y: '1',
              q: '1',
              s: 'serving',
            },
          },
        },
      ],
    });

    expect(report.matchedFoods).toBe(2);
    expect(report.returnedFoods).toBe(2);

    const alpha = report.foods[0];
    expect(alpha?.itemId).toBe('food-a');
    expect(alpha?.kind).toBe('food');
    expect(alpha?.recipeId).toBeNull();
    expect(alpha?.firstConsumedAt).toBe('2026-02-06T09:00:00.000Z');
    expect(alpha?.latestConsumedAt).toBe('2026-02-07T10:00:00.000Z');
    expect(alpha?.nutrition.caloriesKcal).toBe(150);
    expect(alpha?.nutrition.proteinG).toBe(15);
    expect(alpha?.nutrition.carbsG).toBe(30);
    expect(alpha?.nutrition.fatG).toBe(7.5);
    expect(alpha?.nutrition.fiberG).toBe(6);
    expect(alpha?.nutrition.sugarG).toBe(4.5);
    expect(alpha?.nutrition.byCode['291']).toBe(6);
    expect(alpha?.nutrition.byCode.e).toBe(6);
    expect(alpha?.serving).toBe('1.5 serving');
    expect(alpha?.servingGrams).toBe(100);

    const beta = report.foods[1];
    expect(beta?.itemId).toBe('food-b');
    expect(beta?.kind).toBe('food');
    expect(beta?.recipeId).toBeNull();
    expect(beta?.isCustom).toBe(true);
    expect(beta?.nutrition.caloriesKcal).toBe(120);
    expect(beta?.nutrition.fiberG).toBe(2);

    const rows = toConciseRows(report, { dateFormat: 'csv' });
    expect(rows[0]?.name).toBe('Alpha, Food');
    expect(rows[0]?.serving).toBe('1.5 serving');
    expect(rows[0]?.servingGrams).toBe(100);

    const csv = renderCsv(rows);
    expect(csv).toContain('"Alpha, Food"');
    expect(csv).toContain(',1.5 serving,100,150,15,30,7.5,6');
  });

  it('serializes json with flattened named nutrients and hides serving alternatives unless full is set', () => {
    const report = buildMacrofactorApiReport({
      sourcePath: 'api://macrofactor/food-log',
      days: 7,
      start: '2026-02-05T00:00:00.000Z',
      end: '2026-02-08T00:00:00.000Z',
      dayDocuments: [
        {
          date: '2026-02-07',
          document: {
            [toEntryId('2026-02-07T10:00:00.000Z')]: {
              id: 'food-a',
              t: 'Alpha',
              c: '100',
              p: '10',
              e: '20',
              f: '5',
              g: '100',
              w: '100',
              y: '1.5',
              q: '1',
              s: 'serving',
              k: 't',
              291: '4.44',
              269: '3.66',
              306: '44.2',
              m: [{ m: 'serving', q: '1', w: '100' }],
            },
          },
        },
      ],
    });

    const defaultJson = serializeReport(report);
    const defaultFood = (defaultJson.foods as Array<Record<string, unknown>>)[0];
    expect(defaultFood?.serving).toBe('1.5 serving');
    expect(defaultFood?.servingGrams).toBe(100);
    expect(defaultFood?.kind).toBe('food');
    expect(defaultFood?.recipeId).toBeNull();
    expect(defaultFood?.recipeCount).toBeUndefined();
    expect(defaultFood?.recipe).toBeUndefined();
    expect(defaultFood?.servingDefault).toBeUndefined();
    expect(defaultFood?.servingUserSelection).toBeUndefined();
    expect(defaultFood?.servingAlternatives).toBeUndefined();
    expect(defaultFood?.nutrition).toEqual({
      calories_kcal: 150,
      protein_g: 15,
      carbs_g: 30,
      fat_g: 7.5,
      fiber_g: 6.7,
      sugars_g: 5.5,
      potassium_mg: 66,
    });

    const fullJson = serializeReport(report, { full: true });
    const fullFood = (fullJson.foods as Array<Record<string, unknown>>)[0];
    expect(fullFood?.kind).toBe('food');
    expect(fullFood?.recipeId).toBeNull();
    expect(fullFood?.serving).toBe('1.5 serving');
    expect(fullFood?.servingGrams).toBe(100);
    expect(fullFood?.servingAlternatives).toBeUndefined();
  });

  it('marks custom recipe items with a recipe reference while keeping the normal item shape', () => {
    const report = buildMacrofactorApiReport({
      sourcePath: 'api://macrofactor/food-log',
      days: 7,
      start: '2026-02-05T00:00:00.000Z',
      end: '2026-02-08T00:00:00.000Z',
      customFoodInfo: {
        recipe_1: {
          kind: 'recipe',
          recipeId: 'recipe_1',
        },
      },
      dayDocuments: [
        {
          date: '2026-02-07',
          document: {
            [toEntryId('2026-02-07T10:00:00.000Z')]: {
              id: 'recipe_1',
              t: 'Morning Pancake',
              b: 'Custom Recipe',
              c: '100',
              p: '10',
              e: '20',
              f: '5',
              g: '100',
              w: '100',
              y: '1',
              q: '1',
              s: 'serving',
              k: 'c',
            },
          },
        },
      ],
    });

    const food = report.foods[0];
    expect(food?.kind).toBe('recipe');
    expect(food?.recipeId).toBe('recipe_1');
    expect(food?.title).toBe('Morning Pancake');
    expect(food?.serving).toBe('1 serving');

    const json = serializeReport(report);
    const serializedFood = (json.foods as Array<Record<string, unknown>>)[0];
    expect(serializedFood?.kind).toBe('recipe');
    expect(serializedFood?.recipeId).toBe('recipe_1');
    expect(serializedFood?.title).toBe('Morning Pancake');
    expect(serializedFood?.nutrition).toEqual({
      calories_kcal: 100,
      protein_g: 10,
      carbs_g: 20,
      fat_g: 5,
    });
  });

  it('renders full csv rows with all named nutrients', () => {
    const report = buildMacrofactorApiReport({
      sourcePath: 'api://macrofactor/food-log',
      days: 7,
      start: '2026-02-05T00:00:00.000Z',
      end: '2026-02-08T00:00:00.000Z',
      dayDocuments: [
        {
          date: '2026-02-07',
          document: {
            [toEntryId('2026-02-07T10:00:00.000Z')]: {
              id: 'food-a',
              t: 'Alpha',
              c: '100',
              p: '10',
              e: '20',
              f: '5',
              g: '100',
              w: '100',
              y: '1.5',
              q: '1',
              s: 'serving',
              291: '4.44',
              269: '3.66',
              306: '44.2',
            },
          },
        },
      ],
    });

    const fullRows = toFullRows(report, { dateFormat: 'csv' });
    expect(fullRows.columns).toEqual([
      'date',
      'time',
      'name',
      'serving',
      'servingGrams',
      'calories_kcal',
      'protein_g',
      'carbs_g',
      'fat_g',
      'fiber_g',
      'sugars_g',
      'potassium_mg',
    ]);
    expect(fullRows.rows[0]?.serving).toBe('1.5 serving');
    expect(fullRows.rows[0]?.servingGrams).toBe(100);
    expect(fullRows.rows[0]?.fiber_g).toBe(6.7);
    expect(fullRows.rows[0]?.potassium_mg).toBe(66);

    const csv = renderCsvRecords(fullRows.rows, fullRows.columns);
    expect(csv.startsWith('date,time,name,serving,servingGrams,calories_kcal,protein_g,carbs_g,fat_g,fiber_g,sugars_g,potassium_mg\n')).toBe(true);
    expect(csv).toContain('07.02.2026,10:00,Alpha,1.5 serving,100,150,15,30,7.5,6.7,5.5,66');
  });

  it('applies limit after grouping and sorting by latest consumption', () => {
    const report = buildMacrofactorApiReport({
      sourcePath: 'api://macrofactor/food-log',
      days: 30,
      limit: 1,
      nowUnixSeconds: Date.parse('2026-02-08T00:00:00.000Z') / 1000,
      dayDocuments: [
        {
          date: '2026-02-07',
          document: {
            [toEntryId('2026-02-07T10:00:00.000Z')]: {
              id: 'food-a',
              t: 'A',
              c: '100',
              g: '100',
              w: '100',
              y: '1',
            },
            [toEntryId('2026-02-07T11:00:00.000Z')]: {
              id: 'food-b',
              t: 'B',
              c: '200',
              g: '100',
              w: '100',
              y: '1',
            },
          },
        },
      ],
    });

    expect(report.matchedFoods).toBe(2);
    expect(report.returnedFoods).toBe(1);
    expect(report.foods[0]?.itemId).toBe('food-b');
  });
});
