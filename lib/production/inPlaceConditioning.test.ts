import { describe, it, expect } from "vitest";
import { isInPlaceConditioning, planInPlaceSwitches, type ConditioningScheduleRow } from "./inPlaceConditioning";

function row(over: Partial<ConditioningScheduleRow>): ConditioningScheduleRow {
  return {
    id: "x", batch_id: "b1", equipment_id: "fv1", stage: "fermenting",
    planned_start: "2026-09-01", actual_start: null, actual_end: null, cancelled_at: null, volume_bbl: null,
    ...over,
  };
}

const ferm = row({ id: "f", stage: "fermenting", actual_start: "2026-09-01", volume_bbl: 38.5 });
const cond = row({ id: "c", stage: "conditioning", planned_start: "2026-09-15", volume_bbl: 40 });

describe("isInPlaceConditioning", () => {
  it("is conditioning booked on the batch's fermenting tank", () => {
    expect(isInPlaceConditioning(cond, [ferm, cond])).toBe(true);
  });
  it("is not conditioning in a brite", () => {
    const brite = { ...cond, equipment_id: "bt1" };
    expect(isInPlaceConditioning(brite, [ferm, brite])).toBe(false);
  });
  it("ignores another batch's fermenting entry on the tank", () => {
    expect(isInPlaceConditioning(cond, [{ ...ferm, batch_id: "b2" }, cond])).toBe(false);
  });
});

describe("planInPlaceSwitches", () => {
  it("switches on the planned date, backdated", () => {
    expect(planInPlaceSwitches([ferm, cond], "2026-09-20")).toEqual([
      { fermentingId: "f", conditioningId: "c", switchDate: "2026-09-15" },
    ]);
  });
  it("does nothing before the planned date", () => {
    expect(planInPlaceSwitches([ferm, cond], "2026-09-14")).toEqual([]);
  });
  it("switches today when beer leaves the tank before the planned date", () => {
    expect(planInPlaceSwitches([ferm, cond], "2026-09-10", "fv1")[0].switchDate).toBe("2026-09-10");
  });
  it("leaves a batch that has not started fermenting alone", () => {
    expect(planInPlaceSwitches([{ ...ferm, actual_start: null }, cond], "2026-09-20")).toEqual([]);
  });
  it("leaves an already-recorded switch alone", () => {
    expect(planInPlaceSwitches([{ ...ferm, actual_end: "2026-09-15" }, { ...cond, actual_start: "2026-09-15" }], "2026-09-20")).toEqual([]);
  });
  it("leaves conditioning in another tank to the real transfer", () => {
    expect(planInPlaceSwitches([ferm, { ...cond, equipment_id: "bt1" }], "2026-09-20")).toEqual([]);
  });
});
