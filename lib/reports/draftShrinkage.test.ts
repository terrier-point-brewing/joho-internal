import { describe, it, expect } from "vitest";
import { aggregateShrinkage, type SwapShrinkageRow } from "./draftShrinkage";

const rows: SwapShrinkageRow[] = [
  { recipe_id: "r1", occurred_at: "2026-07-01T10:00:00Z", unaccounted_fl_oz: 60, full_fl_oz: 660 },
  { recipe_id: "r1", occurred_at: "2026-07-03T10:00:00Z", unaccounted_fl_oz: 40, full_fl_oz: 660 },
  { recipe_id: "r2", occurred_at: "2026-07-02T10:00:00Z", unaccounted_fl_oz: 990, full_fl_oz: 1980 },
];

describe("aggregateShrinkage", () => {
  it("averages fl oz and pct per recipe using per-row full volume", () => {
    const out = aggregateShrinkage(rows, new Map([["r1", "Vienna"], ["r2", "Porter"]]));
    const r1 = out.find((o) => o.recipe_id === "r1")!;
    expect(r1.beer_name).toBe("Vienna");
    expect(r1.keg_count).toBe(2);
    expect(r1.avg_shrinkage_fl_oz).toBe(50);
    expect(r1.avg_shrinkage_pct).toBe(7.6); // mean(60/660, 40/660)*100 = 7.575 -> 7.6
    expect(r1.events.map((e) => e.date)).toEqual(["2026-07-01", "2026-07-03"]);
  });

  it("computes pct off each row's own full volume (50% for the 1/2 keg)", () => {
    const out = aggregateShrinkage(rows, new Map([["r2", "Porter"]]));
    expect(out.find((o) => o.recipe_id === "r2")!.avg_shrinkage_pct).toBe(50);
  });

  it("sorts recipes by descending avg shrinkage", () => {
    const out = aggregateShrinkage(rows, new Map());
    expect(out[0].recipe_id).toBe("r2");
  });

  it("excludes beer-change kegs — a deliberate dump is not shrinkage", () => {
    // A half keg pulled early to change beers would read as 50% shrinkage and
    // swamp the two real readings for this recipe.
    const out = aggregateShrinkage([
      ...rows,
      { recipe_id: "r1", occurred_at: "2026-07-05T10:00:00Z", unaccounted_fl_oz: 330, full_fl_oz: 660, cause: "beer_change" },
    ], new Map([["r1", "Vienna"]]));
    const r1 = out.find((o) => o.recipe_id === "r1")!;
    expect(r1.keg_count).toBe(2);
    expect(r1.avg_shrinkage_fl_oz).toBe(50);
  });

  it("keeps rows explicitly marked keg_emptied", () => {
    const out = aggregateShrinkage(
      [{ recipe_id: "r1", occurred_at: "2026-07-01T10:00:00Z", unaccounted_fl_oz: 60, full_fl_oz: 660, cause: "keg_emptied" }],
      new Map([["r1", "Vienna"]]),
    );
    expect(out[0].keg_count).toBe(1);
  });
});
