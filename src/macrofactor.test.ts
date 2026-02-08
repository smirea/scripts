import { describe, expect, it } from "bun:test";

import {
  APPLE_REFERENCE_UNIX_SECONDS,
  type MacrofactorReport,
  buildMacrofactorReport,
  renderCsv,
  toConciseRows,
} from "./macrofactor";

describe("buildMacrofactorReport", () => {
  it("filters by date window and parses macros from micros", () => {
    const sample = {
      food: {
        recent: {
          itemId: "recent-item",
          firstConsumedTimeUTC: 99,
          latestConsumedTimeUTC: 100,
          food: {
            title: "Recent Food",
            source: "t",
            isCustom: false,
            micros: ["k", "250", "p", 20, "c", 30, "f", 7, "e", 4],
            recipe: [{ title: "child" }],
            servingAlternatives: [{ name: "g", quantity: 100, weight: 100 }],
          },
        },
        old: {
          itemId: "old-item",
          firstConsumedTimeUTC: 10,
          latestConsumedTimeUTC: 10,
          food: {
            title: "Old Food",
            source: "t",
            isCustom: true,
            micros: ["k", "100", "p", "10", "c", "5", "f", "1"],
          },
        },
      },
    };

    const report = buildMacrofactorReport({
      sourcePath: "/tmp/historyFood.json",
      jsonText: JSON.stringify(sample),
      days: 7,
      start: new Date((APPLE_REFERENCE_UNIX_SECONDS + 90) * 1000).toISOString(),
      end: new Date((APPLE_REFERENCE_UNIX_SECONDS + 110) * 1000).toISOString(),
    });

    expect(report.matchedFoods).toBe(1);
    expect(report.returnedFoods).toBe(1);
    expect(report.foods[0]?.itemId).toBe("recent-item");
    expect(report.foods[0]?.nutrition.caloriesKcal).toBe(250);
    expect(report.foods[0]?.nutrition.proteinG).toBe(20);
    expect(report.foods[0]?.nutrition.carbsG).toBe(30);
    expect(report.foods[0]?.nutrition.fatG).toBe(7);
    expect(report.foods[0]?.nutrition.fiberG).toBe(4);
    expect(report.foods[0]?.recipeCount).toBe(1);
  });

  it("applies limit after sorting latest first", () => {
    const sample = {
      food: {
        a: {
          itemId: "a",
          latestConsumedTimeUTC: 100,
          food: { title: "A", micros: ["k", 100] },
        },
        b: {
          itemId: "b",
          latestConsumedTimeUTC: 200,
          food: { title: "B", micros: ["k", 200] },
        },
      },
    };

    const report = buildMacrofactorReport({
      sourcePath: "/tmp/historyFood.json",
      jsonText: JSON.stringify(sample),
      days: 365,
      limit: 1,
      nowUnixSeconds: APPLE_REFERENCE_UNIX_SECONDS + 250,
    });

    expect(report.matchedFoods).toBe(2);
    expect(report.returnedFoods).toBe(1);
    expect(report.foods[0]?.itemId).toBe("b");
  });
});

describe("concise output", () => {
  it("produces concise rows sorted by timestamp and renders CSV", () => {
    const report: MacrofactorReport = {
      generatedAt: "2026-02-08T00:00:00.000Z",
      sourcePath: "/tmp/historyFood.json",
      window: {
        start: "2026-02-01T00:00:00.000Z",
        end: "2026-02-08T00:00:00.000Z",
      },
      matchedFoods: 2,
      returnedFoods: 2,
      foods: [
        {
          itemId: "a",
          title: "Alpha, Food",
          brandName: null,
          source: "t",
          isCustom: false,
          firstConsumedAt: "2026-02-07T10:00:00.000Z",
          latestConsumedAt: "2026-02-07T10:00:00.000Z",
          recipeCount: 0,
          recipe: [],
          servingDefault: { name: "serving", quantity: 1 },
          servingUserSelection: { name: "serving", quantity: 1.5 },
          servingAlternatives: [],
          nutrition: {
            caloriesKcal: 149.6,
            proteinG: 12.456,
            carbsG: 19.994,
            fatG: 3.501,
            fiberG: 4.444,
            sugarG: null,
            netCarbsG: null,
            alcoholG: null,
            byCode: {},
            named: {},
          },
        },
        {
          itemId: "b",
          title: "Beta Food",
          brandName: null,
          source: "t",
          isCustom: false,
          firstConsumedAt: "2026-02-06T10:00:00.000Z",
          latestConsumedAt: "2026-02-06T10:00:00.000Z",
          recipeCount: 0,
          recipe: [],
          servingDefault: { name: "g", quantity: 100 },
          servingUserSelection: null,
          servingAlternatives: [],
          nutrition: {
            caloriesKcal: 100,
            proteinG: 5,
            carbsG: 10,
            fatG: 1,
            fiberG: null,
            sugarG: null,
            netCarbsG: null,
            alcoholG: null,
            byCode: {},
            named: {},
          },
        },
      ],
    };

    const rows = toConciseRows(report);
    expect(rows[0]?.name).toBe("Alpha, Food");
    expect(rows[0]?.serving).toBe("1.5 serving");
    expect(rows[0]?.calories).toBe(150);
    expect(rows[0]?.protein).toBe(12.46);
    expect(rows[0]?.carbs).toBe(19.99);
    expect(rows[0]?.fat).toBe(3.5);
    expect(rows[0]?.fiber).toBe(4.44);

    const csv = renderCsv(rows);
    expect(csv.startsWith("date,time,name,serving,calories,protein,carbs,fat,fiber\n")).toBe(true);
    expect(csv).toContain("\"Alpha, Food\"");
    expect(csv).toContain(",1.5 serving,150,12.46,19.99,3.5,4.44");
  });
});

