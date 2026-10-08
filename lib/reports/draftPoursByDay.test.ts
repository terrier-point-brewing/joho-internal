import { describe, it, expect } from "vitest";
import { buildDraftPoursByDay } from "./draftPoursByDay";

const names = new Map([["a", "Alpha"], ["b", "Bravo"]]);

describe("buildDraftPoursByDay", () => {
  it("lists every day in the window, oldest first, ending on endDate", () => {
    const out = buildDraftPoursByDay([], names, "2026-10-02", 4);
    expect(out.days).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(out.recipes).toEqual([]);
  });

  it("pivots rows per beer and orders by volume", () => {
    const out = buildDraftPoursByDay(
      [
        { recipe_id: "a", business_date: "2026-10-01", fl_oz: 100 },
        { recipe_id: "b", business_date: "2026-10-01", fl_oz: "250.5" },
        { recipe_id: "b", business_date: "2026-10-02", fl_oz: 49.5 },
      ],
      names, "2026-10-02", 3,
    );
    expect(out.recipes.map((r) => r.beer_name)).toEqual(["Bravo", "Alpha"]);
    expect(out.recipes[0].by_day).toEqual({ "2026-10-01": 250.5, "2026-10-02": 49.5 });
    expect(out.recipes[0].total_fl_oz).toBe(300);
    expect(out.totals_by_day).toEqual({ "2026-10-01": 350.5, "2026-10-02": 49.5 });
    expect(out.total_fl_oz).toBe(400);
  });

  it("averages over the days a beer poured, not the whole window", () => {
    const out = buildDraftPoursByDay(
      [
        { recipe_id: "a", business_date: "2026-10-01", fl_oz: 100 },
        { recipe_id: "a", business_date: "2026-10-02", fl_oz: 300 },
      ],
      names, "2026-10-02", 14,
    );
    expect(out.recipes[0].days_poured).toBe(2);
    expect(out.recipes[0].avg_fl_oz_per_day).toBe(200);
  });

  it("ignores rows outside the window and zero rows", () => {
    const out = buildDraftPoursByDay(
      [
        { recipe_id: "a", business_date: "2026-09-01", fl_oz: 999 },
        { recipe_id: "b", business_date: "2026-10-02", fl_oz: 0 },
      ],
      names, "2026-10-02", 7,
    );
    expect(out.recipes).toEqual([]);
    expect(out.total_fl_oz).toBe(0);
  });
});
