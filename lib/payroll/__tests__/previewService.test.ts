import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DailyShift } from "@/lib/square/labor";
import { aggregateDailyTips, type DailyTips } from "@/lib/square/payroll";
import type {
  Employee,
  PayPeriod,
  PayrollConfig,
  PayrollEntry,
} from "../types";
import type { DayOverride } from "../dailyGrid";

/**
 * previewService.ts is I/O orchestration on top of two Square fetchers
 * (fetchShiftsByDay, fetchTipsAndCashTakeByDay). Those two fetchers are the
 * only network/I/O boundary. We mock ONLY that boundary with deterministic
 * fixtures, then assert on the REAL computed output of buildPayrollPreview:
 * employee filtering, two-step tip attribution, guarantee bucketing across
 * frequencies, adjustment merge, labels, and totals. These are real
 * transforms, not mock-call assertions.
 */

const mockFetchShiftsByDay = vi.fn<(s: string, e: string) => Promise<DailyShift[]>>();
const mockFetchTips = vi.fn<(s: string, e: string) => Promise<DailyTips[]>>();

vi.mock("@/lib/square/labor", () => ({
  fetchShiftsByDay: (s: string, e: string) => mockFetchShiftsByDay(s, e),
}));
// I6 needs the real aggregateDailyTips (to build a refund-netted DailyTips[]
// fixture) alongside the mocked network fetcher, so re-export the actual
// module and override only the I/O boundary.
vi.mock("@/lib/square/payroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/square/payroll")>();
  return {
    ...actual,
    fetchTipsAndCashTakeByDay: (s: string, e: string) => mockFetchTips(s, e),
  };
});

// Imported after vi.mock so the mocks are wired in.
import { buildPayrollPreview } from "../previewService";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: PayrollConfig = {
  id: "c1",
  effective_from: "2026-01-01",
  base_rate_cents: 1000, // $10/hr
  guaranteed_rate_cents: 1500, // $15/hr
  reported_cash_tips_divisor: 10,
  tip_distribution_model: "proportional_hours",
  tip_pool_frequency: "biweekly",
  guaranteed_min_frequency: "biweekly",
  pay_period_frequency: "biweekly",
  due_date_days_after_end: 3,
  created_at: "2026-01-01T00:00:00Z",
};

const period: PayPeriod = {
  id: "p1",
  start_date: "2026-01-05",
  end_date: "2026-01-18", // 14 days (biweekly)
  due_date: null,
  status: "open",
  locked_at: null,
  locked_by: null,
  created_at: "2026-01-01T00:00:00Z",
};

function mkEmployee(over: Partial<Employee> & { id: string }): Employee {
  return {
    first_name: "First",
    last_name: "Last",
    email: "a@b.com",
    phone_number: null,
    job_title: "Bartender",
    employment_type: "hourly",
    receives_tips: true,
    square_team_member_id: `sq-${over.id}`,
    gusto_employee_id: null,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const shift = (team_member_id: string, date: string, hours: number, cash_tips_cents = 0): DailyShift => ({
  team_member_id,
  date,
  hours,
  cash_tips_cents,
});

const tips = (date: string, tipsPooledCents: number): DailyTips => ({
  date,
  tipsPooledCents,
});

beforeEach(() => {
  mockFetchShiftsByDay.mockReset();
  mockFetchTips.mockReset();
  mockFetchShiftsByDay.mockResolvedValue([]);
  mockFetchTips.mockResolvedValue([]);
});

describe("buildPayrollPreview — employee filtering", () => {
  it("keeps only active hourly tipped employees in entries", async () => {
    const employees: Employee[] = [
      mkEmployee({ id: "e1" }), // hourly tipped active → kept
      mkEmployee({ id: "e2", receives_tips: false }), // no tips → excluded
      mkEmployee({ id: "e3", active: false }), // inactive → excluded
      mkEmployee({ id: "e4", employment_type: "salary_no_overtime" }), // salaried → excluded from entries
    ];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.entries.map((e) => e.employee_id)).toEqual(["e1"]);
    expect(preview.employees.map((e) => e.id)).toEqual(["e1"]);
  });

  it("classifies all active non-hourly employees as salaried", async () => {
    const employees: Employee[] = [
      mkEmployee({ id: "s1", employment_type: "salary_no_overtime" }),
      mkEmployee({ id: "s2", employment_type: "salary_overtime_eligible" }),
      mkEmployee({ id: "s3", employment_type: "salary_no_overtime", active: false }), // inactive excluded
      mkEmployee({ id: "e1" }), // hourly → not salaried
    ];

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.salaried_employees.map((e) => e.id)).toEqual(["s1", "s2"]);
  });

  it("keeps tipped employees with no shifts as zero-hour entries", async () => {
    // computePayrollEntries returns an entry for every tipped employee (zero
    // hours if absent). entryIds therefore includes them, so they ARE kept.
    const employees = [mkEmployee({ id: "e1" })];
    // No shifts at all.
    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].hours_worked).toBe(0);
    expect(preview.entries[0].effective_total_compensation_cents).toBe(0);
  });

  it("excludes hourly tipped employees with no square_team_member_id from entries", async () => {
    const employees = [
      mkEmployee({ id: "e1", square_team_member_id: null }),
      mkEmployee({ id: "e2" }),
    ];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e2", "2026-01-05", 5)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    // e1 has no team id → computePayrollEntries filters it out.
    expect(preview.entries.map((e) => e.employee_id)).toEqual(["e2"]);
    expect(preview.employees.map((e) => e.id)).toEqual(["e2"]);
  });
});

describe("buildPayrollPreview — tip attribution (biweekly pool & guarantee)", () => {
  it("distributes pooled tips proportionally to hours across employees", async () => {
    const employees = [mkEmployee({ id: "e1" }), mkEmployee({ id: "e2" })];
    // e1 30h, e2 10h → 75% / 25%
    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 30),
      shift("sq-e2", "2026-01-05", 10),
    ]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 10000)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);
    const e1 = preview.entries.find((e) => e.employee_id === "e1")!;
    const e2 = preview.entries.find((e) => e.employee_id === "e2")!;

    expect(e1.paycheck_tips_cents).toBe(7500);
    expect(e2.paycheck_tips_cents).toBe(2500);
    expect(preview.total_pooled_tips_cents).toBe(10000);
  });

  it("uses per-employee declared cash tips straight from shifts (no rate, no pool)", async () => {
    const employees = [mkEmployee({ id: "e1" }), mkEmployee({ id: "e2" })];
    // Declared cash is intrinsic to each employee's shift — not pooled by hours.
    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 10, 8415),
      shift("sq-e2", "2026-01-05", 30, 500),
    ]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 0)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);
    const e1 = preview.entries.find((e) => e.employee_id === "e1")!;
    const e2 = preview.entries.find((e) => e.employee_id === "e2")!;

    // Each keeps their own declared cash despite e2 working more hours.
    expect(e1.cash_tips_cents).toBe(8415);
    expect(e2.cash_tips_cents).toBe(500);
    // Reported cash = round(actual / divisor 10).
    expect(e1.reported_cash_tips_cents).toBe(842);
    expect(e1.effective_reported_cash_tips_cents).toBe(842);
    expect(e2.reported_cash_tips_cents).toBe(50);
  });

  it("computes guarantee bonus when tips fall short of guaranteed rate", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);
    // No tips. base = 10*1000=10000, guaranteed = 10*1500=15000 → bonus 5000.
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 0)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.entries[0].bonus_cents).toBe(5000);
    expect(preview.entries[0].base_pay_cents).toBe(10000);
    expect(preview.entries[0].total_compensation_cents).toBe(15000);
  });

  it("bonus is zero when paycheck tips push comp above the guarantee", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);
    // tips 10000 + base 10000 = 20000 > guaranteed 15000 → bonus 0.
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 10000)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.entries[0].bonus_cents).toBe(0);
  });
});

describe("buildPayrollPreview — boundaries & fallbacks", () => {
  it("empty employees yields empty entries and zero totals", async () => {
    const preview = await buildPayrollPreview(period, [], baseConfig, []);

    expect(preview.entries).toEqual([]);
    expect(preview.employees).toEqual([]);
    expect(preview.salaried_employees).toEqual([]);
    expect(preview.total_pooled_tips_cents).toBe(0);
  });

  it("no shifts but card tips present → tips go unattributed (zero share), pool total still summed", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    // card tips exist but nobody clocked in → totalGroupHours 0 → share 0.
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 5000)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.entries[0].paycheck_tips_cents).toBe(0);
    // No shifts → no declared cash.
    expect(preview.entries[0].cash_tips_cents).toBe(0);
    // Pool total is summed regardless of attribution.
    expect(preview.total_pooled_tips_cents).toBe(5000);
  });

  it("ignores zero/negative-hour shift rows when attributing (dayHrs <= 0 skipped)", async () => {
    const employees = [mkEmployee({ id: "e1" }), mkEmployee({ id: "e2" })];
    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 0), // skipped in attribution
      shift("sq-e2", "2026-01-05", 10),
    ]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 10000)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);
    const e1 = preview.entries.find((e) => e.employee_id === "e1")!;
    const e2 = preview.entries.find((e) => e.employee_id === "e2")!;

    // e1 contributes 0 hours → denominator is e2's 10h → e2 gets all tips.
    expect(e1.paycheck_tips_cents).toBe(0);
    expect(e2.paycheck_tips_cents).toBe(10000);
  });

  it("rounds attributed tips to whole cents (1/3 split)", async () => {
    const employees = [
      mkEmployee({ id: "e1" }),
      mkEmployee({ id: "e2" }),
      mkEmployee({ id: "e3" }),
    ];
    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 10),
      shift("sq-e2", "2026-01-05", 10),
      shift("sq-e3", "2026-01-05", 10),
    ]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 100)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);
    const shares = preview.entries.map((e) => e.paycheck_tips_cents).sort();

    // 100/3 = 33.33 each. The pool total is an invariant: every share floors
    // to 33 and the one leftover cent goes to the largest fractional
    // remainder (ties breaking key-ascending), landing on 34 rather than
    // being lost the way per-cell Math.round used to lose it.
    expect(shares).toEqual([33, 33, 34]);
  });
});

describe("buildPayrollPreview — frequency granularity", () => {
  it("uses biweekly defaults when frequencies are unset (?? fallback)", async () => {
    // Cast to exercise the nullish-coalescing fallback branch in source.
    const cfg = {
      ...baseConfig,
      tip_pool_frequency: undefined,
      guaranteed_min_frequency: undefined,
    } as unknown as PayrollConfig;
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 5000)]);

    const preview = await buildPayrollPreview(period, employees, cfg, []);

    // Single biweekly bucket → one tip bucket spanning the whole period.
    expect(preview.tip_buckets).toHaveLength(1);
    expect(preview.entries[0].paycheck_tips_cents).toBe(5000);
  });

  it("weekly tip pool produces two tip buckets over a 14-day period", async () => {
    const cfg: PayrollConfig = { ...baseConfig, tip_pool_frequency: "weekly" };
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 5), // week 1
      shift("sq-e1", "2026-01-13", 5), // week 2
    ]);
    mockFetchTips.mockResolvedValue([
      tips("2026-01-05", 3000),
      tips("2026-01-13", 7000),
    ]);

    const preview = await buildPayrollPreview(period, employees, cfg, []);

    expect(preview.tip_buckets).toHaveLength(2);
    expect(preview.tip_buckets[0].tipsPooledCents).toBe(3000);
    expect(preview.tip_buckets[1].tipsPooledCents).toBe(7000);
    // Single employee → all tips attributed regardless of week split.
    expect(preview.entries[0].paycheck_tips_cents).toBe(10000);
  });

  it("daily tip pool produces one bucket per day of the period", async () => {
    const cfg: PayrollConfig = { ...baseConfig, tip_pool_frequency: "daily" };
    const preview = await buildPayrollPreview(period, [], cfg, []);

    // 2026-01-05 .. 2026-01-18 inclusive = 14 days.
    expect(preview.tip_buckets).toHaveLength(14);
  });

  it("tip bucket label uses M/D range for biweekly", async () => {
    const preview = await buildPayrollPreview(period, [], baseConfig, []);
    expect(preview.tip_buckets[0].label).toBe("1/5 – 1/18");
  });

  it("keeps tip pooling and guaranteed-min bucketing independent (daily pool, weekly guarantee)", async () => {
    // 14-day period, two weeks: 1/5–1/11 and 1/12–1/18.
    const cfg: PayrollConfig = { ...baseConfig, tip_pool_frequency: "daily", guaranteed_min_frequency: "weekly" };
    const employees = [mkEmployee({ id: "e1" }), mkEmployee({ id: "e2" })];

    mockFetchShiftsByDay.mockResolvedValue([
      shift("sq-e1", "2026-01-05", 10), // week 1
      shift("sq-e2", "2026-01-06", 10), // week 1
      shift("sq-e1", "2026-01-12", 5),  // week 2
      shift("sq-e2", "2026-01-12", 5),  // week 2
    ]);
    mockFetchTips.mockResolvedValue([
      tips("2026-01-05", 1000), // daily pool: only e1 worked → e1 gets it all
      tips("2026-01-06", 2000), // daily pool: only e2 worked → e2 gets it all
      tips("2026-01-12", 3000), // daily pool: 5:5 split between e1/e2
    ]);

    const preview = await buildPayrollPreview(period, employees, cfg, []);

    // Daily tip pool → one bucket per day of the 14-day period.
    expect(preview.tip_buckets).toHaveLength(14);

    const e1 = preview.entries.find((e) => e.employee_id === "e1")!;
    const e2 = preview.entries.find((e) => e.employee_id === "e2")!;

    // Guarantee re-aggregates the daily-attributed tips at weekly granularity,
    // independent of the daily pooling above.
    // Week 1: e1 10h/1000c tips, guaranteedMin 15000 vs base 10000+tips 1000 → bonus 4000.
    //         e2 10h/2000c tips, guaranteedMin 15000 vs base 10000+tips 2000 → bonus 3000.
    // Week 2: e1 5h/1500c tips,  guaranteedMin 7500  vs base 5000+tips 1500  → bonus 1000.
    //         e2 5h/1500c tips,  guaranteedMin 7500  vs base 5000+tips 1500  → bonus 1000.
    expect(e1.hours_worked).toBe(15);
    expect(e1.paycheck_tips_cents).toBe(2500);
    expect(e1.bonus_cents).toBe(5000);
    expect(e1.total_compensation_cents).toBe(22500);

    expect(e2.hours_worked).toBe(15);
    expect(e2.paycheck_tips_cents).toBe(3500);
    expect(e2.bonus_cents).toBe(4000);
    expect(e2.total_compensation_cents).toBe(22500);
  });
});

describe("buildPayrollPreview — adjustment merge from stored entries", () => {
  it("overrides computed values with stored adjustments", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 0)]);

    const stored: PayrollEntry[] = [
      {
        id: "pe1",
        pay_period_id: "p1",
        employee_id: "e1",
        hours_worked: null,
        paycheck_tips_cents: null,
        cash_tips_cents: null,
        reported_cash_tips_cents: null,
        bonus_cents: null,
        adj_hours_worked: 20,
        adj_paycheck_tips_cents: 4000,
        adj_cash_tips_cents: 100,
        adj_reported_cash_tips_cents: null,
        adj_bonus_cents: 999,
        admin_notes: "manual override",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];

    const preview = await buildPayrollPreview(period, employees, baseConfig, stored);
    const e1 = preview.entries[0];

    expect(e1.effective_hours).toBe(20);
    expect(e1.effective_paycheck_tips_cents).toBe(4000);
    expect(e1.effective_cash_tips_cents).toBe(100);
    // reported not overridden → re-derives from effective actual cash (100/10).
    expect(e1.effective_reported_cash_tips_cents).toBe(10);
    expect(e1.effective_bonus_cents).toBe(999);
    expect(e1.admin_notes).toBe("manual override");
    // effective total = base_pay (computed 10000) + effective tips/cash/bonus
    expect(e1.effective_total_compensation_cents).toBe(10000 + 4000 + 100 + 999);
  });

  it("falls back to computed values when stored entry has no adjustments", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 0)]);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);
    const e1 = preview.entries[0];

    expect(e1.effective_hours).toBe(10);
    expect(e1.effective_bonus_cents).toBe(5000); // guarantee bonus carried through
    expect(e1.admin_notes).toBeNull();
  });
});

// I6 — spec §8 case 1: refund fixture, built via the real aggregateDailyTips
// rather than a hand-written pooled total, to pin PR #276's net-of-refund
// behavior through this refactor.
describe("buildPayrollPreview — refund netting (spec §8 case 1)", () => {
  it("nets a refunded payment's tip out of the pool before attribution", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    mockFetchShiftsByDay.mockResolvedValue([shift("sq-e1", "2026-01-05", 10)]);

    // $10.00 tip on the original payment, $4.00 refunded back → pool nets to $6.00.
    const dailyTips = aggregateDailyTips(
      [
        {
          id: "pay1",
          status: "COMPLETED",
          created_at: "2026-01-05T18:00:00Z",
          tip_money: { amount: 1000 },
        },
      ],
      [
        {
          payment_id: "pay1",
          status: "COMPLETED",
          amount_money: { amount: 400 },
        },
      ]
    );
    mockFetchTips.mockResolvedValue(dailyTips);

    const preview = await buildPayrollPreview(period, employees, baseConfig, []);

    expect(preview.total_pooled_tips_cents).toBe(600);
    // Sole tipped employee absorbs the entire net-of-refund pool.
    expect(preview.entries[0].paycheck_tips_cents).toBe(600);
  });
});

// I7 — spec §8 case 13: highest-risk interaction between a day-level override
// (payroll_shift_overrides, layered into buildDailyGrid before computation)
// and a period-level adj_* (payroll_entries, layered after via mergeAdjustments).
// Period-level must win for the effective/final value, but the day override
// still feeds the pre-adjustment computed value (base_pay_cents).
describe("buildPayrollPreview — day override vs period-level adjustment (spec §8 case 13)", () => {
  it("period-level adj_hours_worked wins for effective_hours; base_pay_cents reflects the day override", async () => {
    const employees = [mkEmployee({ id: "e1" })];
    // No Square shift at all — the day override creates the hours outright
    // (buildDailyGrid: "An override may create a cell that has no underlying shift").
    mockFetchTips.mockResolvedValue([tips("2026-01-05", 0)]);

    const dayOverrides: DayOverride[] = [
      {
        employee_id: "e1",
        work_date: "2026-01-05",
        adj_hours: 8,
        adj_paycheck_tips_cents: null,
        adj_cash_tips_cents: null,
        note: null,
      },
    ];

    const stored: PayrollEntry[] = [
      {
        id: "pe1",
        pay_period_id: "p1",
        employee_id: "e1",
        hours_worked: null,
        paycheck_tips_cents: null,
        cash_tips_cents: null,
        reported_cash_tips_cents: null,
        bonus_cents: null,
        adj_hours_worked: 20, // period-level override
        adj_paycheck_tips_cents: null,
        adj_cash_tips_cents: null,
        adj_reported_cash_tips_cents: null,
        adj_bonus_cents: null,
        admin_notes: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];

    const preview = await buildPayrollPreview(period, employees, baseConfig, stored, dayOverrides);
    const e1 = preview.entries[0];

    // Day override (8h) feeds the pre-adjustment computed hours/base pay.
    expect(e1.hours_worked).toBe(8);
    expect(e1.base_pay_cents).toBe(8000); // 8h * $10/hr base_rate_cents
    // Period-level adj_hours_worked (20) wins for the final effective value.
    expect(e1.effective_hours).toBe(20);
  });
});
