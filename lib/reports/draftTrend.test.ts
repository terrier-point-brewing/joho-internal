import { describe, it, expect } from "vitest";
import {
  bucketOf, bucketsBetween, buildTrend, combineOthers, parseTrendRange, type TrendData,
} from "./draftTrend";

const data: TrendData = {
  start: "2026-09-28",
  end: "2026-10-07",
  recipes: [{ recipe_id: "a", beer_name: "Alpha" }, { recipe_id: "b", beer_name: "Bravo" }],
  events: [
    { recipe_id: "a", date: "2026-09-29", value: 100, aux: 10 },
    { recipe_id: "a", date: "2026-10-01", value: 300, aux: 30 },
    { recipe_id: "b", date: "2026-10-06", value: 50 },
    { recipe_id: "b", date: "2026-08-01", value: 999 }, // outside the window
  ],
};

describe("bucketOf", () => {
  it("maps a date to its day, its Monday, or the 1st", () => {
    expect(bucketOf("2026-10-07", "day")).toBe("2026-10-07");
    expect(bucketOf("2026-10-07", "week")).toBe("2026-10-05");
    expect(bucketOf("2026-10-04", "week")).toBe("2026-09-28"); // Sunday belongs to the week before
    expect(bucketOf("2026-10-07", "month")).toBe("2026-10-01");
  });
});

describe("bucketsBetween", () => {
  it("lists every bucket, including empty ones, across a year boundary", () => {
    expect(bucketsBetween("2026-11-15", "2027-02-01", "month"))
      .toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(bucketsBetween("2026-09-28", "2026-10-07", "week")).toEqual(["2026-09-28", "2026-10-05"]);
    expect(bucketsBetween("2026-10-05", "2026-10-07", "day")).toHaveLength(3);
  });
});

describe("buildTrend", () => {
  it("sums pours per bucket and ranks by volume", () => {
    const t = buildTrend(data, "week", "sum");
    expect(t.rows.map((r) => r.beer_name)).toEqual(["Alpha", "Bravo"]);
    expect(t.rows[0].by_bucket).toEqual({ "2026-09-28": 400 });
    expect(t.rows[1].by_bucket).toEqual({ "2026-10-05": 50 });
    expect(t.rows[1].sum).toBe(50); // the August row is outside the window
    expect(t.overall.by_bucket).toEqual({ "2026-09-28": 400, "2026-10-05": 50 });
    expect(t.overall.sum).toBe(450);
  });

  it("averages per event in mean mode, and averages aux", () => {
    const t = buildTrend(data, "month", "mean");
    const alpha = t.rows.find((r) => r.recipe_id === "a")!;
    expect(alpha.by_bucket).toEqual({ "2026-09-01": 100, "2026-10-01": 300 });
    expect(alpha.count).toBe(2);
    expect(alpha.mean).toBe(200);
    expect(alpha.aux_mean).toBe(20);
    expect(t.rows.find((r) => r.recipe_id === "b")!.aux_mean).toBeNull();
    expect(t.overall.by_bucket["2026-10-01"]).toBe(175);
  });
});

describe("combineOthers", () => {
  it("folds beers outside the keep set into one row", () => {
    const other = combineOthers(data, new Set(["a"]), "day", "sum")!;
    expect(other.beer_name).toBe("Other (1 beer)");
    expect(other.by_bucket).toEqual({ "2026-10-06": 50 });
    expect(combineOthers(data, new Set(["a", "b"]), "day", "sum")).toBeNull();
  });
});

describe("parseTrendRange", () => {
  it("accepts a day count or all, and falls back otherwise", () => {
    expect(parseTrendRange("all", 30)).toBe("all");
    expect(parseTrendRange("90", 30)).toBe(90);
    expect(parseTrendRange(null, 30)).toBe(30);
    expect(parseTrendRange("-4", 30)).toBe(30);
  });
});
