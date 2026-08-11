import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  distributeByWeight, attributeBucket, bucketViolations, cellKey,
  getDays, dayGroups, bucketLabels, buildDailyGrid,
  unattributedBuckets, snapshotPoolVariance,
  fetchDayGridInputs, computeDailyGrid,
} from "./dailyGrid";
import type { DailyShift } from "@/lib/square/labor";
import type { DailyTips } from "@/lib/square/payroll";
import type { Employee, PayPeriod } from "./types";

const mockShifts = vi.fn<(s: string, e: string) => Promise<DailyShift[]>>();
const mockTips   = vi.fn<(s: string, e: string) => Promise<DailyTips[]>>();
vi.mock("@/lib/square/labor",   () => ({ fetchShiftsByDay: (s: string, e: string) => mockShifts(s, e) }));
vi.mock("@/lib/square/payroll", () => ({ fetchTipsAndCashTakeByDay: (s: string, e: string) => mockTips(s, e) }));

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

  it("breaks tied remainders on key ascending, in Map insertion order", () => {
    const w = [{ key: "b", weight: 1 }, { key: "a", weight: 1 }, { key: "c", weight: 1 }];
    expect([...distributeByWeight(100, w)]).toEqual([["b", 33], ["a", 34], ["c", 33]]);
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

  it("zeroes out unpinned cells when pins total exactly the pool", () => {
    const r = attributeBucket(8000, cells, [pin("s1", "2026-07-01", 8000)]);
    expect(r.tips.get(cellKey("s2", "2026-07-01"))).toBe(0);
    expect(r.attributedCents).toBe(8000);
    expect(
      bucketViolations([{
        label: "7/1", days: ["2026-07-01"],
        pool_cents: 8000, pinned_cents: r.pinnedCents, attributed_cents: r.attributedCents,
      }])
    ).toEqual([]);
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

describe("unattributedBuckets", () => {
  const base = { label: "7/1", days: ["2026-07-01"] };

  it("reports a pool that landed on nobody — the case bucketViolations lets through", () => {
    const v = unattributedBuckets([{ ...base, pool_cents: 8000, pinned_cents: 0, attributed_cents: 0 }]);
    expect(v).toEqual([{
      label: "7/1", days: ["2026-07-01"],
      poolCents: 8000, attributedCents: 0, shortfallCents: 8000,
    }]);
  });

  it("reports a partial shortfall", () => {
    const v = unattributedBuckets([{ ...base, pool_cents: 8000, pinned_cents: 0, attributed_cents: 7500 }]);
    expect(v[0].shortfallCents).toBe(500);
  });

  it("stays silent when the bucket balances", () => {
    expect(unattributedBuckets([{ ...base, pool_cents: 8000, pinned_cents: 0, attributed_cents: 8000 }])).toEqual([]);
  });

  it("stays silent when pins overshoot — that is bucketViolations' job", () => {
    expect(unattributedBuckets([{ ...base, pool_cents: 1000, pinned_cents: 5000, attributed_cents: 5000 }])).toEqual([]);
  });

  it("names only the offending buckets in a multi-bucket period", () => {
    const v = unattributedBuckets([
      { label: "7/1", days: ["2026-07-01"], pool_cents: 500, pinned_cents: 0, attributed_cents: 0 },
      { label: "7/2", days: ["2026-07-02"], pool_cents: 900, pinned_cents: 0, attributed_cents: 900 },
    ]);
    expect(v.map(b => b.label)).toEqual(["7/1"]);
  });
});

describe("snapshotPoolVariance", () => {
  it("returns null when the snapshot still matches the live pool", () => {
    expect(snapshotPoolVariance(50000, 50000)).toBeNull();
  });

  it("reports a positive variance when a refund shrank the pool after the lock", () => {
    expect(snapshotPoolVariance(49000, 50000)).toEqual({
      livePoolCents: 49000, snapshotTipsCents: 50000, varianceCents: 1000,
    });
  });

  it("reports a negative variance when the pool grew after the lock", () => {
    expect(snapshotPoolVariance(51000, 50000)?.varianceCents).toBe(-1000);
  });
});

describe("getDays", () => {
  it("returns every date in the inclusive range", () => {
    expect(getDays("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03",
    ]);
  });

  it("returns a single-day array when start equals end", () => {
    expect(getDays("2026-07-01", "2026-07-01")).toEqual(["2026-07-01"]);
  });

  it("crosses a month boundary correctly", () => {
    expect(getDays("2026-07-30", "2026-08-01")).toEqual([
      "2026-07-30", "2026-07-31", "2026-08-01",
    ]);
  });
});

describe("bucketLabels", () => {
  it("labels a biweekly bucket as a single start–end range", () => {
    expect(bucketLabels("biweekly", "2026-07-01", "2026-07-14")).toEqual([
      "7/1 – 7/14",
    ]);
  });

  it("labels a daily bucket with one entry per day", () => {
    expect(bucketLabels("daily", "2026-07-01", "2026-07-03")).toEqual([
      "7/1", "7/2", "7/3",
    ]);
  });

  it("labels weekly buckets with a short trailing chunk when the period is not a multiple of 7", () => {
    // 2026-07-01..2026-07-09 is 9 days: one full 7-day week plus a 2-day tail.
    expect(bucketLabels("weekly", "2026-07-01", "2026-07-09")).toEqual([
      "7/1 – 7/7", "7/8 – 7/9",
    ]);
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

const PERIOD = { id: "p1", start_date: "2026-07-01", end_date: "2026-07-02" } as PayPeriod;
const EMPS = [
  { id: "e1", square_team_member_id: "s1", receives_tips: true,  employment_type: "hourly", active: true },
  { id: "e2", square_team_member_id: "s2", receives_tips: true,  employment_type: "hourly", active: true },
] as Employee[];
const noOv = { adj_hours: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, note: null };

describe("buildDailyGrid", () => {
  beforeEach(() => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 1000 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 500 },
    ]);
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 8000 }]);
  });

  it("splits the pool by hours with no overrides", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", []);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.buckets.find(b => b.days.includes("2026-07-01"))!.attributed_cents).toBe(8000);
  });

  it("rebalances card tips when hours are overridden", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e2", work_date: "2026-07-01", adj_hours: 6 },
    ]);
    expect(g.hoursByDate.get("2026-07-01")!.get("s2")).toBe(6);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(4000);
  });

  it("creates a cell for a day with no Square shift (missed punch) and attributes its pool", async () => {
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 8000 },
      { date: "2026-07-02", tipsPooledCents: 3000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-02", adj_hours: 8 },
    ]);
    expect(g.hoursByDate.get("2026-07-02")!.get("s1")).toBe(8);
    // The synthesized cell is the only worker that day, so it absorbs the
    // whole 3000c pool — proving it actually participates in attribution.
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s1")).toBe(3000);
    const b = g.buckets.find(x => x.days.includes("2026-07-02"))!;
    expect(b.pool_cents).toBe(3000);
    expect(b.attributed_cents).toBe(3000);
  });

  it("replaces declared cash tips without touching hours or card tips", async () => {
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_cash_tips_cents: 4200 },
    ]);
    expect(g.cashByDate.get("2026-07-01")!.get("s1")).toBe(4200);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
  });

  it("does not throw when a shrunken pool leaves stored pins over-committed", async () => {
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 1000 }]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_paycheck_tips_cents: 5000 },
    ]);
    const b = g.buckets.find(x => x.days.includes("2026-07-01"))!;
    // pool 1000, pin 5000 unabsorbable → attributed = pinned 5000, remainder
    // (s2, unpinned) clamps to 0. Exact variance is 5000 - 1000 = 4000.
    expect(b.pool_cents).toBe(1000);
    expect(b.attributed_cents).toBe(5000);
    expect(b.attributed_cents - b.pool_cents).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(5000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(0);
  });

  it("pools across the whole period when biweekly", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-02", hours: 2, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 4000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "biweekly", []);
    expect(g.buckets).toHaveLength(1);
    // One 8000c pool split 6:2 across days — not two independent 4000c pools.
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(2000);
  });

  it("keeps each day independent when daily", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-02", hours: 2, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 4000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", []);
    expect(g.buckets).toHaveLength(2);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(4000);
  });

  it("confines a pin's rebalance to its own bucket when daily", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 0 },
      { team_member_id: "s1", date: "2026-07-02", hours: 4, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 8000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);
    const g = await buildDailyGrid(PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_paycheck_tips_cents: 7000 },
    ]);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(1000);  // rebalanced
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s1")).toBe(4000);  // untouched
  });

  it("excludes an inactive tip-receiving employee's hours from the pool split", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 0 },
      { team_member_id: "s3", date: "2026-07-01", hours: 4, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 8000 }]);
    const emps = [
      ...EMPS,
      { id: "e3", square_team_member_id: "s3", receives_tips: true, employment_type: "hourly", active: false } as unknown as Employee,
    ];
    const g = await buildDailyGrid(PERIOD, emps, "daily", []);
    // Without the fix, s3's 4 hours would be included in the weight split
    // (6:2:4 of 8000 = 4000/1333/2667), diluting s1 and s2's card tips.
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(2000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s3")).toBeUndefined();
    const b = g.buckets.find(x => x.days.includes("2026-07-01"))!;
    expect(b.attributed_cents).toBe(b.pool_cents);
    expect(b.attributed_cents).toBe(8000);
  });

  it("excludes a salaried tip-receiving employee's hours from the pool split", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 0 },
      { team_member_id: "s3", date: "2026-07-01", hours: 4, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 8000 }]);
    const emps = [
      ...EMPS,
      { id: "e3", square_team_member_id: "s3", receives_tips: true, employment_type: "salaried", active: true } as unknown as Employee,
    ];
    const g = await buildDailyGrid(PERIOD, emps, "daily", []);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(2000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s3")).toBeUndefined();
    const b = g.buckets.find(x => x.days.includes("2026-07-01"))!;
    expect(b.attributed_cents).toBe(b.pool_cents);
    expect(b.attributed_cents).toBe(8000);
  });

  it("ignores overrides for an employee with no square_team_member_id", async () => {
    const emps = [...EMPS, { id: "e3", square_team_member_id: null, receives_tips: true, employment_type: "hourly", active: true } as unknown as Employee];
    const g = await buildDailyGrid(PERIOD, emps, "daily", [
      { ...noOv, employee_id: "e3", work_date: "2026-07-01", adj_hours: 5 },
    ]);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    // The map is keyed by square_team_member_id — asserting the raw employee
    // id is absent proves the override wasn't wrongly written under "e3".
    expect(g.hoursByDate.get("2026-07-01")!.has("e3")).toBe(false);
  });

  it("redistributes card tips across days when an override lands in a biweekly (single-pool) bucket", async () => {
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-02", hours: 2, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 4000 },
      { date: "2026-07-02", tipsPooledCents: 4000 },
    ]);

    // Baseline (no override): one 8000c pool split 6:2 across the two days.
    const base = await buildDailyGrid(PERIOD, EMPS, "biweekly", []);
    expect(base.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(6000);
    expect(base.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(2000);

    // Override s2's hours on 07-02 up to 6 — since biweekly pools the whole
    // period as ONE bucket, this rebalances the 07-01 cell too, even though
    // the override itself never touched 07-01.
    const g = await buildDailyGrid(PERIOD, EMPS, "biweekly", [
      { ...noOv, employee_id: "e2", work_date: "2026-07-02", adj_hours: 6 },
    ]);
    expect(g.buckets).toHaveLength(1);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-02")!.get("s2")).toBe(4000);
    const b = g.buckets[0];
    expect(b.pool_cents).toBe(8000);
    expect(b.attributed_cents).toBe(b.pool_cents);
  });

  it("confines a weekly bucket override to its own week over a two-chunk 14-day period", async () => {
    const period14 = { id: "p14", start_date: "2026-07-01", end_date: "2026-07-14" } as PayPeriod;
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 0 },
      { team_member_id: "s1", date: "2026-07-08", hours: 3, cash_tips_cents: 0 },
      { team_member_id: "s2", date: "2026-07-08", hours: 3, cash_tips_cents: 0 },
    ]);
    mockTips.mockResolvedValue([
      { date: "2026-07-01", tipsPooledCents: 8000 },
      { date: "2026-07-08", tipsPooledCents: 6000 },
    ]);

    // Override s2's hours on 07-01 (week 1, days 7/1–7/7) up to 6, matching s1.
    const g = await buildDailyGrid(period14, EMPS, "weekly", [
      { ...noOv, employee_id: "e2", work_date: "2026-07-01", adj_hours: 6 },
    ]);
    expect(g.buckets).toHaveLength(2);

    // Week 1 (7/1–7/7): 6:6 hours → even split of the 8000c pool.
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s1")).toBe(4000);
    expect(g.cardTipsByDate.get("2026-07-01")!.get("s2")).toBe(4000);

    // Week 2 (7/8–7/14, days 7/8): untouched — 3:3 hours → even split of the
    // 6000c pool, exactly as it would be with no override at all.
    expect(g.cardTipsByDate.get("2026-07-08")!.get("s1")).toBe(3000);
    expect(g.cardTipsByDate.get("2026-07-08")!.get("s2")).toBe(3000);
  });
});

describe("fetchDayGridInputs / computeDailyGrid split", () => {
  beforeEach(() => {
    mockShifts.mockClear();
    mockTips.mockClear();
    mockShifts.mockResolvedValue([
      { team_member_id: "s1", date: "2026-07-01", hours: 6, cash_tips_cents: 1000 },
      { team_member_id: "s2", date: "2026-07-01", hours: 2, cash_tips_cents: 500 },
    ]);
    mockTips.mockResolvedValue([{ date: "2026-07-01", tipsPooledCents: 8000 }]);
  });

  // The Shifts route needs two grids over one period (overridden + baseline).
  // Calling buildDailyGrid twice re-ran every paginated Square sequence; this
  // pins that one fetch now serves N computations.
  it("fetches Square once no matter how many grids are computed", async () => {
    const inputs = await fetchDayGridInputs(PERIOD);
    computeDailyGrid(inputs, PERIOD, EMPS, "daily", []);
    computeDailyGrid(inputs, PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-01", adj_hours: 2 },
    ]);
    computeDailyGrid(inputs, PERIOD, EMPS, "biweekly", []);

    expect(mockShifts).toHaveBeenCalledTimes(1);
    expect(mockTips).toHaveBeenCalledTimes(1);
  });

  it("computes an identical grid to buildDailyGrid", async () => {
    const viaWrapper = await buildDailyGrid(PERIOD, EMPS, "daily", []);
    const inputs = await fetchDayGridInputs(PERIOD);
    const viaSplit = computeDailyGrid(inputs, PERIOD, EMPS, "daily", []);

    expect(viaSplit.buckets).toEqual(viaWrapper.buckets);
    expect([...viaSplit.cardTipsByDate.get("2026-07-01")!]).toEqual(
      [...viaWrapper.cardTipsByDate.get("2026-07-01")!],
    );
    expect(viaSplit.totalPooledTipsCents).toBe(viaWrapper.totalPooledTipsCents);
  });

  it("does not mutate the shared inputs between computations", async () => {
    const inputs = await fetchDayGridInputs(PERIOD);
    const before = JSON.stringify(inputs);
    computeDailyGrid(inputs, PERIOD, EMPS, "daily", [
      { ...noOv, employee_id: "e1", work_date: "2026-07-02", adj_hours: 9 },
    ]);
    expect(JSON.stringify(inputs)).toBe(before);
  });
});
