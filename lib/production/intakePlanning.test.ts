import { describe, it, expect } from "vitest";
import { buildDemandCalendar, type CommitmentDemand } from "@/app/production/lib/demandCalendar";
import { commitmentPieces, commitmentRemainders, inTankRemainingBbl } from "./intakeDemand.server";
import { validateBatchPlan, normalizeStage } from "./batchPlan";
import { planTankSlots, occupiedTanksAsEntries } from "./tankSlots";
import type { Recipe } from "@/app/production/types";

const TODAY = new Date("2026-09-21T12:00:00"); // a Monday
const recipe = (over: Partial<Recipe> = {}) => ({
  id: "r1", beer_name: "Pils", style: "Pils", expected_yield_bbl: 18,
  days_brewhouse: 1, days_fermenter: 14, days_brite: 6, ...over,
}) as Recipe;
const commitment = (over: Partial<CommitmentDemand> = {}): CommitmentDemand => ({
  id: "c1", recipe_id: "r1", channel: "distribution", desired_delivery_date: "2026-10-05",
  unshipped_bbl: 10, unallocated_bbl: 10, ...over,
});
const calendar = (over: Partial<Parameters<typeof buildDemandCalendar>[0]> = {}) =>
  buildDemandCalendar({ currentBblByRecipe: new Map(), commitments: [], batchInflows: [], recipes: [recipe()], today: TODAY, ...over });

describe("buildDemandCalendar", () => {
  it("starts from cold storage on hand and subtracts only the unshipped part of a commitment", () => {
    const [row] = calendar({ currentBblByRecipe: new Map([["r1", 12]]), commitments: [commitment({ unshipped_bbl: 4 })] });
    expect(row.current_bbl).toBe(12);
    expect(row.weeks.at(-1)!.projected_eow_bbl).toBe(8);
    expect(row.stockout_date).toBeNull();
  });

  it("counts wholesale in its own channel", () => {
    const [row] = calendar({ commitments: [commitment({ channel: "wholesale" })] });
    expect(row.weeks.find((w) => w.weekStart === "2026-10-05")!.wholesale_outflow_bbl).toBe(10);
  });

  it("lands undated and overdue commitments in the current week instead of dropping them", () => {
    const [row] = calendar({ commitments: [
      commitment({ id: "a", desired_delivery_date: null, unshipped_bbl: 3 }),
      commitment({ id: "b", desired_delivery_date: "2026-08-01", unshipped_bbl: 2 }),
    ] });
    expect(row.weeks[0].distribution_outflow_bbl).toBe(5);
    expect(row.stockout_date).toBe(row.weeks[0].weekStart);
  });

  it("keeps a late batch's beer as inflow rather than recommending a duplicate", () => {
    const [row] = calendar({
      commitments: [commitment({ desired_delivery_date: null })],
      batchInflows: [{ recipe_id: "r1", expected_delivery_date: "2026-09-01", remaining_bbl: 18 }],
    });
    expect(row.stockout_date).toBeNull();
  });

  it("warns only inside 1.5x lead time; a far-off stockout stays green", () => {
    const lead = 21;
    const at = (date: string) => calendar({ commitments: [commitment({ desired_delivery_date: date })] })[0].status;
    expect(at("2026-09-28")).toBe("red");     // 7d  <= lead
    expect(at("2026-10-19")).toBe("yellow");  // 28d <= 1.5 x lead
    expect(at("2026-11-30")).toBe("green");   // 70d
    expect(lead * 1.5).toBe(31.5);
  });
});

describe("commitmentRemainders", () => {
  it("nets shipments and existing allocations off the booked volume", () => {
    expect(commitmentRemainders({ bookedBbl: 10, allocations: [{ percentage: 25, batchVolumeBbl: 40, exportedBbl: 4 }] }))
      .toEqual({ unshipped_bbl: 6, unallocated_bbl: 0 });
  });
  it("is the full booking when nothing is allocated", () => {
    expect(commitmentRemainders({ bookedBbl: 10, allocations: [] })).toEqual({ unshipped_bbl: 10, unallocated_bbl: 10 });
  });
});

describe("inTankRemainingBbl", () => {
  it("counts a partly packaged batch's remainder, never negative", () => {
    expect(inTankRemainingBbl({ expectedBbl: 36, packagedBbl: 20 })).toBe(16);
    expect(inTankRemainingBbl({ expectedBbl: 36, packagedBbl: 40 })).toBe(0);
  });
});

describe("validateBatchPlan", () => {
  const base = { schedule: [], allocations: [], commitmentChannelById: new Map<string, string | null>(), busy: [] };
  it("maps Intake's tank words onto Brewing's stage names", () => {
    expect(normalizeStage("fermenter")).toBe("fermenting");
    expect(normalizeStage("brite")).toBe("conditioning");
    expect(normalizeStage("lagering")).toBeNull();
  });
  it("refuses a wholesale commitment booked as contract brewing", () => {
    expect(validateBatchPlan({ ...base, commitmentChannelById: new Map([["c1", "wholesale"]]),
      allocations: [{ channel: "contract_brewing", percentage: 50, contract_request_id: "c1" }] })).toMatch(/wholesale/);
  });
  it("refuses over 100% and partner channels with no commitment", () => {
    expect(validateBatchPlan({ ...base, allocations: [{ channel: "taproom", percentage: 60 }, { channel: "taproom", percentage: 50 }] })).toMatch(/100%/);
    expect(validateBatchPlan({ ...base, allocations: [{ channel: "distribution", percentage: 10 }] })).toMatch(/commitment/);
  });
  it("refuses a tank that is already booked", () => {
    expect(validateBatchPlan({ ...base,
      schedule: [{ stage: "fermenter", equipment_id: "t1", planned_start: "2026-10-01", planned_end: "2026-10-15" }],
      busy: [{ equipment_id: "t1", start: "2026-10-10T12:00:00", end: "2026-10-20T12:00:00" }],
      tankNameById: new Map([["t1", "FV1"]]) })).toMatch(/FV1 is already booked/);
  });
  it("passes a clean plan", () => {
    expect(validateBatchPlan({ ...base, commitmentChannelById: new Map([["c1", "distribution"]]),
      schedule: [{ stage: "brite", equipment_id: "t2", planned_start: "2026-10-15", planned_end: "2026-10-21" }],
      allocations: [{ channel: "distribution", percentage: 40, contract_request_id: "c1" }, { channel: "taproom", percentage: 60 }] })).toBeNull();
  });
});

describe("planTankSlots", () => {
  const tanks = [
    { id: "bh", name: "Brewhouse", type: "brewhouse", capacity_bbl: 20 },
    { id: "f1", name: "FV1", type: "fermenter", capacity_bbl: 40 },
    { id: "f2", name: "FV2", type: "fermenter", capacity_bbl: 40 },
    { id: "b1", name: "BT1", type: "brite", capacity_bbl: 40 },
    { id: "b2", name: "BT2", type: "brite", capacity_bbl: 40 },
  ];
  const days = { brewhouse: 1, fermenter: 14, brite: 6 };
  it("splits a batch too big for one tank across two instead of giving up", () => {
    const plan = planTankSlots({ tanks, entries: [], volumeBbl: 72, turns: 4, startDate: TODAY, days });
    expect(plan.feasible).toBe(true);
    expect(plan.sequence.filter((s) => s.stage === "fermenter")).toHaveLength(2);
    expect(plan.sequence.find((s) => s.stage === "fermenter")!.scheduled_start).toBe(plan.sequence[0].scheduled_start);
  });
  it("says why when nothing fits", () => {
    const plan = planTankSlots({ tanks, entries: [], volumeBbl: 100, turns: 5, startDate: TODAY, days });
    expect(plan.feasible).toBe(false);
    expect(plan.reason).toMatch(/does not fit/);
  });
  it("treats a physically occupied, unscheduled tank as busy", () => {
    const busy = occupiedTanksAsEntries([{ tank_id: "f1", assigned_at: "2026-09-10T12:00:00" }], [], TODAY);
    const plan = planTankSlots({ tanks, entries: busy, volumeBbl: 36, turns: 2, startDate: TODAY, days });
    expect(plan.sequence.find((s) => s.stage === "fermenter")!.equipment_id).toBe("f2");
  });
});

describe("commitmentPieces", () => {
  it("holds the share on an in-tank batch until that batch lands; the rest is due on the desired date", () => {
    expect(commitmentPieces({ bookedBbl: 20, desiredDate: "2026-09-01",
      allocations: [{ percentage: 25, batchVolumeBbl: 40, exportedBbl: 2, landsOn: "2026-10-05" }] }))
      .toEqual([{ bbl: 8, date: "2026-10-05" }, { bbl: 10, date: "2026-09-01" }]);
  });
  it("a finished batch that came in short owes its share of what it made", () => {
    expect(commitmentPieces({ bookedBbl: 30, desiredDate: "2026-08-06",
      allocations: [{ percentage: 75, batchVolumeBbl: 40, exportedBbl: 11.5, landsOn: null, producedBbl: 32 }] }))
      .toEqual([{ bbl: 12.5, date: "2026-08-06" }]);
  });
  it("an overdue deal with a batch on the way is not a stockout", () => {
    const [row] = calendar({
      commitments: [commitment({ desired_delivery_date: "2026-09-01", pieces: [{ bbl: 10, date: "2026-10-05" }] })],
      batchInflows: [{ recipe_id: "r1", expected_delivery_date: "2026-10-05", remaining_bbl: 18 }],
    });
    expect(row.stockout_date).toBeNull();
  });
});
