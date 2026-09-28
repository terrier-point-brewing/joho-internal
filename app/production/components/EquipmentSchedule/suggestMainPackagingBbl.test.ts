import { describe, it, expect } from "vitest";
import { suggestMainPackagingBbl } from "./constants";
import type { ScheduleEntry } from "../../hooks/queries";
import type { BatchConversion } from "../../types";

const BATCH = "b1";
const entry = (stage: string, volume_bbl: number | null, planned_branch: string | null = null) =>
  ({ id: `${stage}-${planned_branch}`, batch_id: BATCH, stage, volume_bbl, planned_branch, cancelled_at: null } as unknown as ScheduleEntry);
const conversion = (volume_bbl: number, source_batch_id = BATCH) =>
  ({ id: "c", source_batch_id, volume_bbl, converted_at: null } as unknown as BatchConversion);

describe("suggestMainPackagingBbl", () => {
  it("nets a planned conversion out of the yield (B-069: 40 BBL, 30 to Cherry Chocolate Stout)", () => {
    const r = suggestMainPackagingBbl({ expectedYieldBbl: 40, entries: [entry("conditioning", null)], batchId: BATCH, batchConversions: [conversion(30)] });
    expect(r).toEqual({ kegging: 7, canning: 3 });
  });

  it("ignores another batch's conversions", () => {
    const r = suggestMainPackagingBbl({ expectedYieldBbl: 40, entries: [], batchId: BATCH, batchConversions: [conversion(30, "other")] });
    expect(r).toEqual({ kegging: 28, canning: 12 });
  });

  it("nets out volume handed to a split branch", () => {
    const r = suggestMainPackagingBbl({ expectedYieldBbl: 40, entries: [entry("conditioning", 20, "B")], batchId: BATCH, batchConversions: [] });
    expect(r).toEqual({ kegging: 14, canning: 6 });
  });

  it("gives all the remainder to the one missing packaging stage", () => {
    const r = suggestMainPackagingBbl({ expectedYieldBbl: 40, entries: [entry("kegging", 25)], batchId: BATCH, batchConversions: [conversion(5)] });
    expect(r).toEqual({ kegging: 0, canning: 10 });
  });

  it("never goes negative when sinks exceed the yield", () => {
    const r = suggestMainPackagingBbl({ expectedYieldBbl: 20, entries: [], batchId: BATCH, batchConversions: [conversion(30)] });
    expect(r).toEqual({ kegging: 0, canning: 0 });
  });
});
