import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/square/taproomConsumption", () => ({ deriveTaproomConsumption: vi.fn() }));
vi.mock("@/lib/production/recordTaproomConsumption", () => ({ recordTaproomConsumption: vi.fn() }));
vi.mock("@/lib/square/inventory", () => ({ setPhysicalCount: vi.fn() }));

import { runTaproomConsumptionSync, remainingDelta } from "./taproomConsumptionSync";
import { deriveTaproomConsumption } from "@/lib/square/taproomConsumption";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { setPhysicalCount } from "@/lib/square/inventory";

const derive = vi.mocked(deriveTaproomConsumption);
const record = vi.mocked(recordTaproomConsumption);
const recount = vi.mocked(setPhysicalCount);

const RECOUNT = { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" };

// Fake supabase: export_transactions "already recorded" lookup returns `rows`.
function fakeSupabase(rows: { source_ref: string; quantity: number }[]) {
  return {
    from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }),
  } as never;
}

const unit = (over: Partial<Record<string, unknown>> = {}) => ({
  recipeId: "r1", variationId: "v1", quantity: 3,
  sourceRef: "sqsale:sv1:2026-07-03", kind: "keg_sale" as const,
  label: "Beer · 1/6 Keg · 2026-07-03", ...over,
});

beforeEach(() => { derive.mockReset(); record.mockReset(); recount.mockReset(); });

describe("remainingDelta", () => {
  it("returns the unrecorded remainder", () => { expect(remainingDelta(3, 2)).toBe(1); });
  it("is zero when fully recorded", () => { expect(remainingDelta(3, 3)).toBe(0); });
  it("never goes negative when over-recorded", () => { expect(remainingDelta(2, 3)).toBe(0); });
  it("returns the full target when nothing recorded", () => { expect(remainingDelta(1, 0)).toBe(1); });
});

describe("runTaproomConsumptionSync", () => {
  it("skips units already fully recorded and records nothing", async () => {
    derive.mockResolvedValue({ units: [unit()], discrepancies: [] });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "sqsale:sv1:2026-07-03", quantity: 3 }]), { days: 2 });
    expect(record).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.recorded).toHaveLength(0);
  });

  it("records only the remaining delta", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-A" })], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"] });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "ref-A", quantity: 2 }]), { days: 2 });
    // target 3, already 2 -> delta 1
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 1, sourceRef: "ref-A" }));
    expect(res.recorded).toHaveLength(1);
    expect(res.totalRecordedQty).toBe(1);
  });

  it("flags a short-stock shortfall as a discrepancy", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-B", quantity: 3 })], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 2, exportTransactionIds: ["x"] });
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    const short = res.discrepancies.find((d) => d.kind === "short_stock");
    expect(short).toMatchObject({ kind: "short_stock", shortfallQty: 2, recordedQty: 1 });
  });

  it("passes config discrepancies through and counts a zero-record as skipped", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "ref-C" })],
      discrepancies: [{ kind: "unconfigured_draft_swap", recipeId: "r9", beerName: "Hazy", swapCount: 2 }],
    });
    record.mockResolvedValue({ recordedQty: 0, shortfallQty: 3, exportTransactionIds: [] });
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(res.recorded).toHaveLength(0);
    expect(res.skipped).toBe(1);
    expect(res.discrepancies.some((d) => d.kind === "unconfigured_draft_swap")).toBe(true);
    expect(res.discrepancies.some((d) => d.kind === "short_stock")).toBe(true);
  });

  it("recounts the draft SKU once when a restock swap is first recorded", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "sqtransfer:o1:l1", kind: "draft_swap", quantity: 1, recount: RECOUNT })],
      discrepancies: [],
    });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"] });
    recount.mockResolvedValue(undefined);

    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(recount).toHaveBeenCalledTimes(1);
    expect(recount).toHaveBeenCalledWith("draft-sqvar", 660, "2026-07-04T20:00:00Z");
    expect(res.recountsApplied).toBe(1);
  });

  it("does NOT recount when the restock swap was already recorded on a prior run", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "sqtransfer:o1:l1", kind: "draft_swap", quantity: 1, recount: RECOUNT })],
      discrepancies: [],
    });
    // already recorded 1 → delta 0 → nothing to record → no recount
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "sqtransfer:o1:l1", quantity: 1 }]), { days: 2 });
    expect(recount).not.toHaveBeenCalled();
    expect(res.recountsApplied).toBe(0);
  });

  it("flags recount_failed but still records the shipment when Square write throws", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "sqtransfer:o2:l2", kind: "draft_swap", quantity: 1, recount: RECOUNT })],
      discrepancies: [],
    });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"] });
    recount.mockRejectedValue(new Error("Square 429"));

    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(res.recorded).toHaveLength(1);
    expect(res.recountsApplied).toBe(0);
    expect(res.discrepancies.find((d) => d.kind === "recount_failed")).toMatchObject({
      kind: "recount_failed", sourceRef: "sqtransfer:o2:l2", detail: "Square 429",
    });
  });
});
