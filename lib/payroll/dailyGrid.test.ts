import { describe, it, expect } from "vitest";
import {
  distributeByWeight, attributeBucket, bucketViolations, cellKey,
  getDays, dayGroups,
} from "./dailyGrid";

const cell = (sq: string, date: string, hours: number) => ({ employeeId: sq, date, hours });
const pin  = (sq: string, date: string, cents: number) => ({ employeeId: sq, date, cents });
const sum  = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

describe("distributeByWeight", () => {
  it("splits proportionally", () => {
    const out = distributeByWeight(1000, [{ key: "a", weight: 3 }, { key: "b", weight: 1 }]);
    expect(out.get("a")).toBe(750);
    expect(out.get("b")).toBe(250);
  });

  it("sums exactly to the total when the split does not divide evenly", () => {
    const out = distributeByWeight(1000, [
      { key: "a", weight: 1 }, { key: "b", weight: 1 }, { key: "c", weight: 1 },
    ]);
    expect(sum(out)).toBe(1000);
  });

  it("is deterministic under tied remainders", () => {
    const w = [{ key: "b", weight: 1 }, { key: "a", weight: 1 }, { key: "c", weight: 1 }];
    expect([...distributeByWeight(100, w)]).toEqual([...distributeByWeight(100, w)]);
  });

  it("gives every key zero when no weight is positive", () => {
    const out = distributeByWeight(500, [{ key: "a", weight: 0 }]);
    expect(out.get("a")).toBe(0);
  });
});

describe("attributeBucket", () => {
  const cells = [cell("s1", "2026-07-01", 6), cell("s2", "2026-07-01", 2)];

  it("splits the pool by hours when nothing is pinned", () => {
    const r = attributeBucket(8000, cells, []);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(6000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(2000);
    expect(r.attributedCents).toBe(8000);
    expect(r.pinnedCents).toBe(0);
  });

  it("honors a pin exactly and pushes the remainder onto unpinned cells", () => {
    const r = attributeBucket(8000, cells, [pin("s1", "2026-07-01", 5000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(5000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(3000);
    expect(r.attributedCents).toBe(8000);
  });

  it("keeps the pool exact with multiple pins", () => {
    const three = [...cells, cell("s3", "2026-07-01", 4)];
    const r = attributeBucket(9000, three, [
      pin("s1", "2026-07-01", 1000), pin("s2", "2026-07-01", 2000),
    ]);
    expect(r.attributedCents).toBe(9000);
    expect(r.tips.get(cellKey("s3", "2026-07-01"))).toBe(6000);
  });

  it("does not throw and never goes negative when pins exceed the pool", () => {
    const r = attributeBucket(1000, cells, [pin("s1", "2026-07-01", 5000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(5000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(0);
    expect(r.attributedCents).toBe(5000);
    expect(r.pinnedCents).toBe(5000);
  });

  it("attributes pins only when no unpinned cell can absorb the remainder", () => {
    const r = attributeBucket(8000, [cell("s1", "2026-07-01", 6)], [pin("s1", "2026-07-01", 5000)]);
    expect(r.attributedCents).toBe(5000);
  });

  it("attributes nothing when nobody worked and nothing is pinned", () => {
    const r = attributeBucket(8000, [], []);
    expect(r.attributedCents).toBe(0);
  });

  it("drops a cell whose hours were overridden to zero", () => {
    const r = attributeBucket(8000, [cell("s1", "2026-07-01", 0), cell("s2", "2026-07-01", 2)], []);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(8000);
  });

  it("allows a pin on a zero-hour cell", () => {
    const r = attributeBucket(8000, [cell("s2", "2026-07-01", 2)], [pin("s1", "2026-07-01", 3000)]);
    expect(r.tips.get(cellKey("s1", "2026-07-01"))).toBe(3000);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(5000);
    expect(r.attributedCents).toBe(8000);
  });
});

describe("bucketViolations", () => {
  const base = { label: "7/1", days: ["2026-07-01"] };

  it("reports nothing when the bucket balances", () => {
    expect(bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 5000, attributed_cents: 8000 }])).toEqual([]);
  });

  it("reports pins_exceed_pool", () => {
    const v = bucketViolations([{ ...base, pool_cents: 1000, pinned_cents: 5000, attributed_cents: 5000 }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe("pins_exceed_pool");
  });

  it("reports no_absorber when pins exist and the pool is under-attributed", () => {
    const v = bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 5000, attributed_cents: 5000 }]);
    expect(v[0].kind).toBe("no_absorber");
  });

  it("does not report an unattributable pool when nothing is pinned", () => {
    expect(bucketViolations([{ ...base, pool_cents: 8000, pinned_cents: 0, attributed_cents: 0 }])).toEqual([]);
  });
});

describe("dayGroups", () => {
  const days = getDays("2026-07-01", "2026-07-14");

  it("returns one group per day when daily", () => {
    expect(dayGroups(days, "daily")).toHaveLength(14);
  });

  it("returns 7-day chunks when weekly, matching ShiftTimeline's chunking", () => {
    const g = dayGroups(days, "weekly");
    expect(g).toHaveLength(2);
    expect(g[0]).toHaveLength(7);
  });

  it("returns a single group when biweekly", () => {
    expect(dayGroups(days, "biweekly")).toHaveLength(1);
  });
});
