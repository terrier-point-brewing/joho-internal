// lib/cron/jobs/taproomConsumptionSafetyNet.test.ts
//
// Why the nightly taproom safety net reported "recorded 0" every night from
// 2026-07-06 to 2026-08-06 while 55 units sat unbooked, and what now makes that
// state tell itself apart from a healthy one.
//
// Two independent faults produced the same silent summary:
//
//   1. A sale the run cannot SEE. `fetchOrderSalesByDay` asks Square only about
//      the variation ids `recipe_square_links` currently holds, and drops every
//      other line inside the bucketer. When Epic Hazy's Square variations were
//      deleted and recreated, the links kept pointing at the dead ids, so real
//      sales on the live ids never became consumption units at all — and a run
//      with no units to examine reported exactly what a clean night reports.
//
//   2. A run that could not LOOK. Seven consecutive runs failed (2026-07-11 →
//      07-17) and the next successful one asked for the same fixed 2-day window,
//      so the whole week was written off. Nothing widened, nothing complained.
//
// The reproductions below are the "before"; the assertions after each are the
// behaviour that now distinguishes the two states.
import { describe, it, expect, vi } from "vitest";

import { bucketOrderLinesByDay, type DayBucketOrder } from "@/lib/square/inventory";
import { assembleConsumption, type KegCanLink } from "@/lib/square/taproomConsumption";
import { planWindow } from "./taproomConsumptionSync";

// The real ids from the incident: the link pointed at DEAD_VAR, the till rang LIVE_VAR.
const LIVE_VAR = "PHXJF7P33QSBJFMISOAF4V7F";
const DEAD_VAR = "DEADVARIATIONIDXXXXXXXXX";

/** Order ZCE1gNjKczC7weDtDlNLQ1JvJebZY, reduced to the fields the bucketer reads. */
const epicHazySale: DayBucketOrder = {
  closed_at: "2026-08-01T16:43:06.218Z",
  created_at: "2026-08-01T16:43:04.074Z",
  line_items: [
    { catalog_object_id: LIVE_VAR, quantity: "1" },
  ],
};

const linkToDeadVariation: KegCanLink = {
  squareVariationId: DEAD_VAR,
  recipeId: "7a2c2d84",
  variationId: "6177b466",
  kind: "can_sale",
  beerName: "Epic Hazy IPA",
  variationName: "Regular - 16oz 4-Pack",
};

describe("reproduction — a sale the run cannot see", () => {
  it("drops a real sale inside the bucketer when the link points at a dead variation", () => {
    // This is the 2026-08-02 07:14Z cron window, and Square really does return
    // this order for it — verified against prod. The loss happens after the
    // fetch, in the `ids` filter.
    const byDay = bucketOrderLinesByDay([epicHazySale], {
      ids: [DEAD_VAR],
      excludeTransfers: true,
    });

    expect(byDay.size).toBe(0);
    expect(byDay.get(`${LIVE_VAR}\t2026-08-01`)).toBeUndefined();
  });

  it("yields no unit and no discrepancy — identical to a night with nothing to do", () => {
    const blind = assembleConsumption({
      salesByDay: bucketOrderLinesByDay([epicHazySale], { ids: [DEAD_VAR] }),
      kegCanLinks: [linkToDeadVariation],
      draftLinks: [],
    });
    const quiet = assembleConsumption({
      salesByDay: new Map<string, number>(),
      kegCanLinks: [linkToDeadVariation],
      draftLinks: [],
    });

    // The bug in one assertion: a beer that left the building and a night with
    // no sales at all produced byte-identical output.
    expect(blind.units).toEqual(quiet.units);
    expect(blind.discrepancies).toEqual(quiet.discrepancies);
    expect(blind.units).toHaveLength(0);
  });

  it("names the sale once the live variation is offered as a candidate", () => {
    // The #387 repair: fetch sales for unmapped siblings of mapped items too, so
    // the sale is reported instead of filtered out before assembly sees it.
    const { units, discrepancies } = assembleConsumption({
      salesByDay: bucketOrderLinesByDay([epicHazySale], { ids: [DEAD_VAR, LIVE_VAR] }),
      kegCanLinks: [linkToDeadVariation],
      draftLinks: [],
      unmappedSaleCandidates: new Set([LIVE_VAR]),
    });

    expect(units).toHaveLength(0); // still unbookable — but no longer silent
    expect(discrepancies).toEqual([
      { kind: "unmapped_sale", squareVariationId: LIVE_VAR, quantity: 1, days: ["2026-08-01"] },
    ]);
  });
});

/** Minimal supabase double for `planWindow`'s single cron_runs read. */
function fakeCronRuns(rows: unknown[], error: { message: string } | null = null) {
  const q = {
    select: () => q,
    eq: () => q,
    not: () => q,
    order: () => q,
    limit: async () => ({ data: rows, error }),
  };
  return { from: () => q } as never;
}

const runWithWindow = (endIso: string) => ({ detail: { window: { startIso: "x", endIso, days: 14 } } });

describe("planWindow — a failed night hands its days to the next run", () => {
  it("uses the 14-day baseline when no prior run recorded a window", async () => {
    const plan = await planWindow(fakeCronRuns([]), new Date("2026-08-07T07:00:00Z"));
    expect(plan).toEqual({ days: 14, coveredThrough: null, widened: false });
  });

  it("stays on the baseline after a normal night", async () => {
    const plan = await planWindow(
      fakeCronRuns([runWithWindow("2026-08-06T07:56:06Z")]),
      new Date("2026-08-07T07:14:00Z"),
    );
    expect(plan.days).toBe(14);
    expect(plan.widened).toBe(false);
  });

  it("covers the seven-night outage that the old 2-day window wrote off", async () => {
    // The real outage: the last inspected window ended 2026-07-10T07:36Z, seven
    // runs then failed, and the next success was 2026-07-18T07:10Z. Under
    // WINDOW_DAYS=2 everything rung in between was never looked at again. An
    // 8-day gap now sits inside the baseline, so no widening is even needed.
    const now = new Date("2026-07-18T07:10:12Z");
    const plan = await planWindow(fakeCronRuns([runWithWindow("2026-07-10T07:36:31Z")]), now);

    expect(plan.days).toBe(14);
    expect(plan.widened).toBe(false);
    expect(plan.coveredThrough).toBe("2026-07-10T07:36:31Z");

    // The whole point: the window reaches back past the start of the outage.
    const start = new Date(now.getTime() - plan.days * 86400000);
    expect(start.toISOString() < "2026-07-10T07:36:31Z").toBe(true);
  });

  it("widens beyond the baseline when the gap outruns it", async () => {
    const now = new Date("2026-08-07T07:00:00Z");
    const plan = await planWindow(fakeCronRuns([runWithWindow("2026-07-14T07:00:00Z")]), now);

    expect(plan.days).toBe(25); // 24 days of gap + 1 day of boundary overlap
    expect(plan.widened).toBe(true);

    const start = new Date(now.getTime() - plan.days * 86400000);
    expect(start.toISOString() < "2026-07-14T07:00:00Z").toBe(true);
  });

  it("caps the widening so a long silence cannot become an unbounded scan", async () => {
    const plan = await planWindow(
      fakeCronRuns([runWithWindow("2026-01-01T00:00:00Z")]),
      new Date("2026-08-07T07:00:00Z"),
    );
    expect(plan.days).toBe(45);
    expect(plan.widened).toBe(true);
  });

  it("falls back to the baseline rather than not running when the anchor is unreadable", async () => {
    const plan = await planWindow(
      fakeCronRuns([], { message: "column detail->window->>endIso does not exist" }),
      new Date("2026-08-07T07:00:00Z"),
    );
    expect(plan).toEqual({ days: 14, coveredThrough: null, widened: false });
  });
});

// The job itself: a run that never looked must not be logged as a quiet success,
// because that is precisely what advances the catch-up anchor past days nobody
// examined.
vi.mock("@/lib/production/taproomConsumptionSync", () => ({ runTaproomConsumptionSync: vi.fn() }));
vi.mock("@/lib/production/phantomExportAlerts", () => ({
  fetchUnemailedPhantomAlerts: vi.fn(async () => []),
  markPhantomAlertsEmailed: vi.fn(),
}));
vi.mock("@/lib/production/phantomAlertEmail", () => ({ renderPhantomAlertEmail: vi.fn() }));
vi.mock("@/lib/resend", () => ({ sendEmail: vi.fn(), ADMIN_EMAIL: "admin@example.com" }));

import { runTaproomConsumptionJob } from "./taproomConsumptionSync";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";

const sync = vi.mocked(runTaproomConsumptionSync);

const syncResult = (over: Record<string, unknown> = {}) => ({
  shipmentId: "s1", windowDays: 14, lockSkipped: false,
  window: { startIso: "2026-07-24T00:00:00Z", endIso: "2026-08-07T07:00:00Z", days: 14 },
  unitsExamined: 12, recorded: [], recordedUnits: 0,
  alreadyRecorded: 12, bookedNothing: 0, skipped: 12, totalRecordedQty: 0,
  recountsApplied: 0, swapsConsumed: 0, packsBrokenDown: 0,
  packagingWarnings: [], discrepancies: [],
  squareWriteback: { applied: 0, planned: [], warnings: [], pushEnabled: false },
  ...over,
}) as never;

describe("runTaproomConsumptionJob", () => {
  it("reports the window and the examined population on a clean night", async () => {
    sync.mockResolvedValue(syncResult());
    const out = await runTaproomConsumptionJob(fakeCronRuns([]));

    // "recorded 0" is the healthy steady state behind the webhook — but it is now
    // qualified by proof that the run looked at something.
    expect(out.recordedUnits).toBe(0);
    expect(out.unitsExamined).toBe(12);
    expect(out.window?.endIso).toBe("2026-08-07T07:00:00Z");
    expect(out.catchUp).toEqual({ days: 14, coveredThrough: null, widened: false });
  });

  it("fails the run when the lease was held, instead of logging a quiet success", async () => {
    sync.mockResolvedValue(syncResult({ lockSkipped: true, window: null, unitsExamined: 0, alreadyRecorded: 0, skipped: 0 }));

    await expect(runTaproomConsumptionJob(fakeCronRuns([]))).rejects.toThrow(/held the lease/);
  });
});
