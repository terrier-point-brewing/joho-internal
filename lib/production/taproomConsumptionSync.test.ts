import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/square/taproomConsumption", () => ({ deriveTaproomConsumption: vi.fn() }));
vi.mock("@/lib/production/recordTaproomConsumption", () => ({ recordTaproomConsumption: vi.fn() }));
vi.mock("@/lib/square/inventory", () => ({
  setPhysicalCount: vi.fn(),
  fetchInventoryChanges: vi.fn(),
}));
vi.mock("@/lib/production/reconcileSquareCanInventory", () => ({
  reconcileSquareCanInventory: vi.fn(async () => ({ writes: [], skips: [], warnings: [], applied: 0 })),
}));

import { runTaproomConsumptionSync, remainingDelta, onHandAtOrBefore } from "./taproomConsumptionSync";
import { deriveTaproomConsumption } from "@/lib/square/taproomConsumption";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { setPhysicalCount, fetchInventoryChanges, type InventoryChange } from "@/lib/square/inventory";
import { reconcileSquareCanInventory } from "@/lib/production/reconcileSquareCanInventory";

const derive = vi.mocked(deriveTaproomConsumption);
const record = vi.mocked(recordTaproomConsumption);
const recount = vi.mocked(setPhysicalCount);
const fetchChanges = vi.mocked(fetchInventoryChanges);
const reconcile = vi.mocked(reconcileSquareCanInventory);

const RECOUNT = { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" };

// A PHYSICAL_COUNT ledger entry (absolute IN_STOCK reset — e.g. a keg swap to full).
const pc = (quantity: number, occurredAt: string): InventoryChange => ({
  type: "PHYSICAL_COUNT", catalog_object_id: "draft-sqvar",
  state: "IN_STOCK", quantity, occurred_at: occurredAt,
});

// An ADJUSTMENT ledger entry that pulls `quantity` out of IN_STOCK (a pour: IN_STOCK → SOLD).
const pour = (quantity: number, occurredAt: string): InventoryChange => ({
  type: "ADJUSTMENT", catalog_object_id: "draft-sqvar",
  from_state: "IN_STOCK", to_state: "SOLD", quantity, occurred_at: occurredAt,
});

// Fake supabase: export_transactions "already recorded" lookup returns `rows`;
// draft_swap_shrinkage upserts are captured into `sink.shrinkage`. `rpc` backs
// the lease lock — `lockAcquired` controls whether try_acquire_sync_lock grants
// it; release_sync_lock calls are captured in `sink.released`.
function fakeSupabase(
  rows: { source_ref: string; quantity: number }[],
  sink?: { shrinkage: unknown[]; released?: number },
  opts: { lockAcquired?: boolean } = {},
) {
  const lockAcquired = opts.lockAcquired ?? true;
  return {
    rpc: async (fn: string) => {
      if (fn === "try_acquire_sync_lock") return { data: lockAcquired, error: null };
      if (fn === "release_sync_lock") { if (sink) sink.released = (sink.released ?? 0) + 1; return { data: null, error: null }; }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === "draft_swap_shrinkage") {
        return { upsert: async (row: unknown) => { sink?.shrinkage.push(row); return { error: null }; } };
      }
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    },
  } as never;
}

const unit = (over: Partial<Record<string, unknown>> = {}) => ({
  recipeId: "r1", variationId: "v1", quantity: 3,
  sourceRef: "sqsale:sv1:2026-07-03", kind: "keg_sale" as const,
  label: "Beer · 1/6 Keg · 2026-07-03", ...over,
});

const canUnit = (over: Partial<Record<string, unknown>> = {}) => ({
  recipeId: "r-can", variationId: "v-can", quantity: 2,
  sourceRef: "sqsale:sv-can:2026-07-03", kind: "can_sale" as const,
  label: "Beer · Can · 2026-07-03", ...over,
});

const swapUnit = (over: Record<string, unknown> = {}) => ({
  recipeId: "r1", variationId: "pv-keg", quantity: 1,
  sourceRef: "sqtransfer:ord-1:line-1", kind: "draft_swap" as const,
  label: "Vienna · Tap 3 restock · 2026-07-04", tapNumber: 3,
  recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
  ...over,
});

beforeEach(() => {
  derive.mockReset(); record.mockReset(); recount.mockReset(); fetchChanges.mockReset();
  reconcile.mockReset();
  reconcile.mockResolvedValue({ writes: [], skips: [], warnings: [], applied: 0 });
});

describe("remainingDelta", () => {
  it("returns the unrecorded remainder", () => { expect(remainingDelta(3, 2)).toBe(1); });
  it("is zero when fully recorded", () => { expect(remainingDelta(3, 3)).toBe(0); });
  it("never goes negative when over-recorded", () => { expect(remainingDelta(2, 3)).toBe(0); });
  it("returns the full target when nothing recorded", () => { expect(remainingDelta(1, 0)).toBe(1); });
});

describe("onHandAtOrBefore", () => {
  it("subtracts pours adjusted out of IN_STOCK since the last full-keg reset", () => {
    // Keg reset to 660 on 07-02, then 16 + 32 fl oz poured before the swap.
    const changes = [
      pc(660, "2026-07-02T15:00:00Z"),
      pour(16, "2026-07-03T18:00:00Z"),
      pour(32, "2026-07-04T12:00:00Z"),
    ];
    expect(onHandAtOrBefore(changes, "2026-07-04T20:00:00Z")).toBe(660 - 16 - 32);
  });

  it("ignores pours after the timestamp and before the anchoring reset", () => {
    const changes = [
      pour(99, "2026-07-01T00:00:00Z"), // before the reset — already baked into it
      pc(500, "2026-07-02T00:00:00Z"),
      pour(20, "2026-07-03T00:00:00Z"),
      pour(40, "2026-07-05T00:00:00Z"), // after the swap timestamp
    ];
    expect(onHandAtOrBefore(changes, "2026-07-04T20:00:00Z")).toBe(500 - 20);
  });

  it("anchors on the latest reset when kegs were swapped mid-window", () => {
    const changes = [
      pc(660, "2026-07-01T00:00:00Z"),
      pour(600, "2026-07-01T12:00:00Z"),
      pc(660, "2026-07-03T00:00:00Z"), // fresh keg — supersedes everything prior
      pour(45, "2026-07-04T10:00:00Z"),
    ];
    expect(onHandAtOrBefore(changes, "2026-07-04T20:00:00Z")).toBe(660 - 45);
  });

  it("credits adjustments back into IN_STOCK (e.g. a returned pour)", () => {
    const changes = [
      pc(660, "2026-07-02T00:00:00Z"),
      pour(50, "2026-07-03T00:00:00Z"),
      { type: "ADJUSTMENT", catalog_object_id: "draft-sqvar", from_state: "SOLD", to_state: "IN_STOCK", quantity: 10, occurred_at: "2026-07-03T06:00:00Z" } as InventoryChange,
    ];
    expect(onHandAtOrBefore(changes, "2026-07-04T20:00:00Z")).toBe(660 - 50 + 10);
  });

  it("never returns negative when pours exceed the reset (data drift)", () => {
    const changes = [pc(100, "2026-07-02T00:00:00Z"), pour(140, "2026-07-03T00:00:00Z")];
    expect(onHandAtOrBefore(changes, "2026-07-04T20:00:00Z")).toBe(0);
  });

  it("returns null when no physical count precedes the timestamp", () => {
    expect(onHandAtOrBefore([pc(660, "2026-07-05T00:00:00Z")], "2026-07-04T20:00:00Z")).toBeNull();
  });
});

describe("runTaproomConsumptionSync", () => {
  it("skips the whole run when another run holds the lease lock", async () => {
    // The webhook fires this sync on every order.* event, so a restock burst
    // spawns overlapping runs. A run that loses the lock must do NOTHING —
    // never derive, never record — so it can't write duplicate rows.
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([], undefined, { lockAcquired: false }), { days: 2 });
    expect(res.lockSkipped).toBe(true);
    expect(derive).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(res.recorded).toHaveLength(0);
  });

  it("acquires the lock, runs, and releases it on a normal run", async () => {
    const sink = { shrinkage: [] as unknown[], released: 0 };
    derive.mockResolvedValue({ units: [], discrepancies: [] });
    const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
    expect(res.lockSkipped).toBe(false);
    expect(sink.released).toBe(1);
  });

  it("releases the lock even when the run throws", async () => {
    const sink = { shrinkage: [] as unknown[], released: 0 };
    derive.mockRejectedValue(new Error("derive boom"));
    await expect(
      runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 }),
    ).rejects.toThrow("derive boom");
    expect(sink.released).toBe(1);
  });

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
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "ref-A", quantity: 2 }]), { days: 2 });
    // target 3, already 2 -> delta 1
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 1, sourceRef: "ref-A" }));
    expect(res.recorded).toHaveLength(1);
    expect(res.totalRecordedQty).toBe(1);
    expect(res.packsBrokenDown).toBe(0);
  });

  it("counts a pack break-down surfaced by recordTaproomConsumption", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-A" })], discrepancies: [] });
    record.mockResolvedValue({
      recordedQty: 1,
      shortfallQty: 0,
      exportTransactionIds: ["x"],
      breaks: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      warnings: [],
    });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "ref-A", quantity: 2 }]), { days: 2 });
    expect(res.packsBrokenDown).toBe(1);
  });

  it("counts a pack break-down even when nothing ended up recordable", async () => {
    // A break can mutate cold-storage inventory (parent decremented, child
    // credited) yet the topped-up tier still falls short of the requested
    // delta, so recordTaproomConsumption records 0. The break itself still
    // happened and should still be counted.
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-A" })], discrepancies: [] });
    record.mockResolvedValue({
      recordedQty: 0,
      shortfallQty: 1,
      exportTransactionIds: [],
      breaks: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      warnings: [],
    });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "ref-A", quantity: 2 }]), { days: 2 });
    expect(res.packsBrokenDown).toBe(1);
    expect(res.recorded).toHaveLength(0);
  });

  it("collects deriveCansEach warnings surfaced by recordTaproomConsumption into packagingWarnings, de-duplicated", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "ref-A" }), unit({ sourceRef: "ref-D", recipeId: "r2" })],
      discrepancies: [],
    });
    const warning = "6-pack variation v-pack: volume implies 4 cans, expected 6 for format '6-pack'";
    record.mockResolvedValue({
      recordedQty: 1,
      shortfallQty: 0,
      exportTransactionIds: ["x"],
      breaks: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      warnings: [warning],
    });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "ref-A", quantity: 2 }, { source_ref: "ref-D", quantity: 2 }]), { days: 2 });
    expect(res.packagingWarnings).toEqual([warning]);
  });

  it("flags a short-stock shortfall as a discrepancy", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-B", quantity: 3 })], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 2, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    const short = res.discrepancies.find((d) => d.kind === "short_stock");
    expect(short).toMatchObject({ kind: "short_stock", shortfallQty: 2, recordedQty: 1 });
  });

  it("passes config discrepancies through and counts a zero-record as skipped", async () => {
    derive.mockResolvedValue({
      units: [unit({ sourceRef: "ref-C" })],
      discrepancies: [{ kind: "unconfigured_draft_swap", recipeId: "r9", beerName: "Hazy", swapCount: 2 }],
    });
    record.mockResolvedValue({ recordedQty: 0, shortfallQty: 3, exportTransactionIds: [], breaks: [], warnings: [] });
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
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
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
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    recount.mockRejectedValue(new Error("Square 429"));

    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(res.recorded).toHaveLength(1);
    expect(res.recountsApplied).toBe(0);
    expect(res.discrepancies.find((d) => d.kind === "recount_failed")).toMatchObject({
      kind: "recount_failed", sourceRef: "sqtransfer:o2:l2", detail: "Square 429",
    });
  });

  it("captures shrinkage once and recounts to full on first record", async () => {
    const sink = { shrinkage: [] as unknown[] };
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    // Reset to a full 660 keg, then 615 fl oz poured before the swap → 45 remaining.
    fetchChanges.mockResolvedValue([
      pc(660, "2026-07-02T15:00:00Z"),
      pour(615, "2026-07-04T18:00:00Z"),
    ]);
    const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
    expect(sink.shrinkage).toHaveLength(1);
    expect(sink.shrinkage[0]).toMatchObject({
      source_ref: "sqtransfer:ord-1:line-1", recipe_id: "r1", tap_number: 3,
      remaining_fl_oz: 45, full_fl_oz: 660, occurred_at: "2026-07-04T20:00:00Z",
    });
    expect(recount).toHaveBeenCalledWith("draft-sqvar", 660, "2026-07-04T20:00:00Z");
    expect(res.recountsApplied).toBe(1);
  });

  it("does not capture shrinkage again when already recorded", async () => {
    const sink = { shrinkage: [] as unknown[] };
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "sqtransfer:ord-1:line-1", quantity: 1 }], sink), { days: 2 });
    expect(sink.shrinkage).toHaveLength(0);
    expect(recount).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it("flags shrinkage capture failure without aborting the recount", async () => {
    const sink = { shrinkage: [] as unknown[] };
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    fetchChanges.mockRejectedValue(new Error("square down"));
    const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
    expect(recount).toHaveBeenCalled();
    expect(res.discrepancies).toContainEqual(
      expect.objectContaining({ kind: "shrinkage_capture_failed", sourceRef: "sqtransfer:ord-1:line-1" }));
  });

  it("reconciles Square can inventory for the can-sale recipes this run touched", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-A" }), canUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipeIds: expect.arrayContaining(["r-can"]) }),
    );
    // keg-only recipe "r1" should not be swept in — only the can-sale recipeId.
    expect(reconcile.mock.calls[0]?.[1]?.recipeIds).toEqual(["r-can"]);
    expect(res.squareWriteback).toEqual({ applied: 0, writes: [], warnings: [] });
  });

  it("does not call the reconciler when no can_sale units are in this run", async () => {
    derive.mockResolvedValue({ units: [unit({ sourceRef: "ref-A" })], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("captures a reconciler failure into squareWriteback.warnings without throwing", async () => {
    derive.mockResolvedValue({ units: [canUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    reconcile.mockRejectedValue(new Error("Square down"));
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(res.squareWriteback.warnings).toEqual(["reconcile failed: Square down"]);
    expect(res.recorded).toHaveLength(1); // sync itself still completes
  });
});
