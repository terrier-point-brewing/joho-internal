import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/square/taproomConsumption", () => ({ deriveTaproomConsumption: vi.fn() }));
vi.mock("@/lib/production/recordTaproomConsumption", () => ({ recordTaproomConsumption: vi.fn() }));
vi.mock("@/lib/square/inventory", () => ({
  setPhysicalCount: vi.fn(),
  fetchCurrentCounts: vi.fn(),
}));
vi.mock("@/lib/production/reconcileSquareCanInventory", () => ({
  reconcileSquareCanInventory: vi.fn(async () => ({ writes: [], skips: [], warnings: [], applied: 0 })),
}));

import { runTaproomConsumptionSync, remainingDelta } from "./taproomConsumptionSync";
import { deriveTaproomConsumption } from "@/lib/square/taproomConsumption";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";
import { reconcileSquareCanInventory } from "@/lib/production/reconcileSquareCanInventory";

const derive = vi.mocked(deriveTaproomConsumption);
const record = vi.mocked(recordTaproomConsumption);
const recount = vi.mocked(setPhysicalCount);
const fetchCounts = vi.mocked(fetchCurrentCounts);
const reconcile = vi.mocked(reconcileSquareCanInventory);

const RECOUNT = { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" };

// Fake supabase: export_transactions "already recorded" lookup returns `rows`;
// draft_swap_shrinkage upserts are captured into `sink.shrinkage`. `rpc` backs
// the lease lock — `lockAcquired` controls whether try_acquire_sync_lock grants
// it; release_sync_lock calls are captured in `sink.released`. recipe_square_links
// returns no rows so the best-effort draft_pour_consumption sync (wired in
// after the accounting write path) no-ops cleanly — its own behavior is
// covered by syncDraftPourConsumption.test.ts.
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
      if (table === "recipe_square_links") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
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
  occurredAt: "2026-07-04T20:00:00Z",
  recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
  ...over,
});

// ─── Queued beer-change swap fixtures ────────────────────────────────────────

const pendingSwap = (over: Record<string, unknown> = {}) => ({
  id: "swap-1", tapNumber: 3,
  fromRecipeId: "r-old", fromBeerName: "Vienna Lager",
  fromVariationId: "pv-old", fromVolumeFlOz: 1984,
  fromDraftSquareVariationId: "draft-sqvar-old",
  toRecipeId: "r-new", toBeerName: "Hazy IPA",
  toVariationId: "pv-new", toVolumeFlOz: 661,
  toDraftSquareVariationId: "draft-sqvar-new",
  openedAt: "2026-07-04T15:00:00Z",
  ...over,
});

/** A restock unit that consumes a queued beer-change transition. */
const transitionUnit = (swapOver: Record<string, unknown> = {}, unitOver: Record<string, unknown> = {}) =>
  swapUnit({
    recipeId: "r-new", variationId: "pv-new",
    recount: { squareVariationId: "draft-sqvar-new", quantity: 661, occurredAt: "2026-07-04T20:00:00Z" },
    swap: pendingSwap(swapOver),
    ...unitOver,
  });

interface SwapSink {
  shrinkage: unknown[];
  released?: number;
  claims: { id: string; sourceRef: string }[];
  flips: Record<string, unknown>[];
  retires: Record<string, unknown>[];
}

const emptySwapSink = (): SwapSink => ({ shrinkage: [], claims: [], flips: [], retires: [] });

/**
 * Fake supabase covering the swap path: the conditional claim on
 * tap_swap_transitions, the tap_assignments flip, the "outgoing beer on another
 * tap" count, and the taproom_recipe_settings un-retire.
 *
 * `claimWins: false` simulates a concurrent run that already claimed the
 * transition. `otherTapsWithOutgoing` simulates the outgoing beer still pouring
 * elsewhere, which must suppress zeroing.
 */
function fakeSupabaseSwaps(
  rows: { source_ref: string; quantity: number }[],
  sink: SwapSink,
  opts: { claimWins?: boolean; otherTapsWithOutgoing?: number } = {},
) {
  const claimWins = opts.claimWins ?? true;
  const others = opts.otherTapsWithOutgoing ?? 0;
  return {
    rpc: async (fn: string) => {
      if (fn === "try_acquire_sync_lock") return { data: true, error: null };
      if (fn === "release_sync_lock") { sink.released = (sink.released ?? 0) + 1; return { data: null, error: null }; }
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === "tap_swap_transitions") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => ({
              is: () => ({
                select: async () => {
                  if (!claimWins) return { data: [], error: null };
                  sink.claims.push({ id, sourceRef: patch.consumed_source_ref as string });
                  return { data: [{ id }], error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "tap_assignments") {
        return {
          update: (patch: Record<string, unknown>) => ({
            eq: async () => { sink.flips.push(patch); return { error: null }; },
          }),
          select: () => ({
            eq: async () => ({
              data: Array.from({ length: others }, (_, i) => ({ tap_number: 90 + i })),
              error: null,
            }),
          }),
        };
      }
      if (table === "taproom_recipe_settings") {
        return { upsert: async (p: Record<string, unknown>) => { sink.retires.push(p); return { error: null }; } };
      }
      if (table === "draft_swap_shrinkage") {
        return { upsert: async (row: unknown) => { sink.shrinkage.push(row); return { error: null }; } };
      }
      if (table === "recipe_square_links") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      return { select: () => ({ in: async () => ({ data: rows, error: null }) }) };
    },
  } as never;
}

beforeEach(() => {
  derive.mockReset(); record.mockReset(); recount.mockReset(); fetchCounts.mockReset();
  reconcile.mockReset();
  reconcile.mockResolvedValue({ writes: [], skips: [], warnings: [], applied: 0 });
});

describe("remainingDelta", () => {
  it("returns the unrecorded remainder", () => { expect(remainingDelta(3, 2)).toBe(1); });
  it("is zero when fully recorded", () => { expect(remainingDelta(3, 3)).toBe(0); });
  it("never goes negative when over-recorded", () => { expect(remainingDelta(2, 3)).toBe(0); });
  it("returns the full target when nothing recorded", () => { expect(remainingDelta(1, 0)).toBe(1); });
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
    // Square's calculated on-hand for the draft base variation, read before the recount.
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar", 45]]));
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
    fetchCounts.mockRejectedValue(new Error("square down"));
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

  it("still recounts the draft SKU when a restock swap is phantom-only (no cold storage on hand)", async () => {
    // recordedQty 0, shortfallQty > 0: no physical stock moved, but the phantom
    // excise row still means the swap was newly and durably recorded this run,
    // so the mapped draft SKU must still be reset to full in Square.
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 0, shortfallQty: 1, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    recount.mockResolvedValue(undefined);

    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    expect(recount).toHaveBeenCalledTimes(1);
    expect(recount).toHaveBeenCalledWith("draft-sqvar", 660, "2026-07-04T20:00:00Z");
    expect(res.recountsApplied).toBe(1);
  });

  it("does NOT capture shrinkage for a phantom-only swap (no physical inventory moved)", async () => {
    const sink = { shrinkage: [] as unknown[] };
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 0, shortfallQty: 1, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar", 45]]));
    const res = await runTaproomConsumptionSync(fakeSupabase([], sink), { days: 2 });
    expect(sink.shrinkage).toHaveLength(0);
    expect(fetchCounts).not.toHaveBeenCalled();
    expect(recount).toHaveBeenCalledWith("draft-sqvar", 660, "2026-07-04T20:00:00Z");
    expect(res.recountsApplied).toBe(1);
  });

  it("skips a restock swap already fully recorded (physical + phantom) on a prior run", async () => {
    derive.mockResolvedValue({
      units: [swapUnit({ quantity: 1 })],
      discrepancies: [],
    });
    // alreadyRecorded 1 covers the full target (whether physical or phantom) -> delta 0
    const res = await runTaproomConsumptionSync(
      fakeSupabase([{ source_ref: "sqtransfer:ord-1:line-1", quantity: 1 }]), { days: 2 });
    expect(record).not.toHaveBeenCalled();
    expect(recount).not.toHaveBeenCalled();
    expect(res.recountsApplied).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it("still flags short_stock for a phantom-only swap", async () => {
    derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 0, shortfallQty: 1, exportTransactionIds: ["x"], breaks: [], warnings: [] });
    const res = await runTaproomConsumptionSync(fakeSupabase([]), { days: 2 });
    const short = res.discrepancies.find((d) => d.kind === "short_stock");
    expect(short).toMatchObject({ kind: "short_stock", requestedQty: 1, recordedQty: 0, shortfallQty: 1 });
  });
});

// ─── Queued beer-change swaps ────────────────────────────────────────────────
//
// A beer-changing swap has TWO recipes. The outgoing keg is pulled early and its
// remaining beer dumped, so its residual belongs in shrinkage against the
// OUTGOING beer and its Square draft SKU must be zeroed — neither of which the
// like-for-like path could express.

describe("runTaproomConsumptionSync — queued swap transitions", () => {
  it("writes off the outgoing keg against the OUTGOING recipe and zeroes its SKU", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 412]]));

    const res = await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    // Residual read from the OUTGOING SKU, full volume from the OUTGOING keg.
    expect(fetchCounts).toHaveBeenCalledWith(["draft-sqvar-old"]);
    expect(sink.shrinkage).toEqual([{
      source_ref: "sqtransfer:ord-1:line-1",
      recipe_id: "r-old",
      tap_number: 3,
      occurred_at: "2026-07-04T20:00:00Z",
      remaining_fl_oz: 412,
      full_fl_oz: 1984,
    }]);
    expect(recount).toHaveBeenCalledWith("draft-sqvar-old", 0, "2026-07-04T20:00:00Z");
    expect(res.swapsConsumed).toBe(1);
  });

  it("still recounts the incoming beer to a full keg", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 0]]));

    await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(recount).toHaveBeenCalledWith("draft-sqvar-new", 661, "2026-07-04T20:00:00Z");
  });

  it("deducts the INCOMING keg from cold storage", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 0]]));

    await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      recipeId: "r-new", variationId: "pv-new", quantity: 1,
    }));
  });

  it("flips the tap onto the incoming beer and un-retires it", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 0]]));

    await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(sink.flips).toHaveLength(1);
    expect(sink.flips[0]).toMatchObject({
      recipe_id: "r-new", swap_variation_id: "pv-new", swap_volume_fl_oz: 661,
    });
    // Tapping a beer means it's active — leaving is_retired set would make the
    // batch scheduler refuse to brew more of a beer that's actively pouring.
    expect(sink.retires).toHaveLength(1);
    expect(sink.retires[0]).toMatchObject({ recipe_id: "r-new", is_retired: false, retired_at: null });
  });

  it("does nothing outgoing when the claim loses to a concurrent run", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 412]]));

    const res = await runTaproomConsumptionSync(
      fakeSupabaseSwaps([], sink, { claimWins: false }), { days: 2 });

    expect(sink.shrinkage).toEqual([]);
    expect(sink.flips).toEqual([]);
    expect(sink.retires).toEqual([]);
    expect(recount).not.toHaveBeenCalledWith("draft-sqvar-old", 0, expect.anything());
    expect(res.swapsConsumed).toBe(0);
    // The incoming side is guarded independently and still runs.
    expect(record).toHaveBeenCalled();
  });

  it("skips zeroing when the outgoing beer is still on another tap", async () => {
    // The draft SKU is per recipe, so zeroing would wipe the other tap's beer and
    // the residual reading would be the combined level across both.
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 412]]));

    const res = await runTaproomConsumptionSync(
      fakeSupabaseSwaps([], sink, { otherTapsWithOutgoing: 1 }), { days: 2 });

    expect(sink.shrinkage).toEqual([]);
    expect(recount).not.toHaveBeenCalledWith("draft-sqvar-old", 0, expect.anything());
    expect(res.discrepancies).toContainEqual(expect.objectContaining({
      kind: "multi_tap_outgoing_skipped", tapNumber: 3, recipeId: "r-old", beerName: "Vienna Lager",
    }));
    // The flip and the incoming recount still happen.
    expect(sink.flips).toHaveLength(1);
    expect(recount).toHaveBeenCalledWith("draft-sqvar-new", 661, "2026-07-04T20:00:00Z");
  });

  it("does no outgoing work when the swap fills a previously empty tap", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({
      units: [transitionUnit({ fromRecipeId: null, fromBeerName: null, fromVariationId: null, fromVolumeFlOz: null, fromDraftSquareVariationId: null })],
      discrepancies: [],
    });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map());

    const res = await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(sink.shrinkage).toEqual([]);
    expect(res.discrepancies).toEqual([]);
    expect(res.swapsConsumed).toBe(1);
    expect(sink.flips).toHaveLength(1);
  });

  it("flags the outgoing recipe having no draft Square link", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({
      units: [transitionUnit({ fromDraftSquareVariationId: null })],
      discrepancies: [],
    });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map());

    const res = await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(sink.shrinkage).toEqual([]);
    expect(res.discrepancies).toContainEqual(expect.objectContaining({ kind: "shrinkage_capture_failed" }));
    // Incoming side unaffected.
    expect(recount).toHaveBeenCalledWith("draft-sqvar-new", 661, "2026-07-04T20:00:00Z");
  });

  it("a Square failure zeroing the outgoing SKU never blocks the incoming recount", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 412]]));
    recount.mockImplementation(async (varId: string) => {
      if (varId === "draft-sqvar-old") throw new Error("square 429");
    });

    const res = await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(res.discrepancies).toContainEqual(expect.objectContaining({
      kind: "shrinkage_capture_failed", detail: "square 429",
    }));
    expect(recount).toHaveBeenCalledWith("draft-sqvar-new", 661, "2026-07-04T20:00:00Z");
    expect(res.recountsApplied).toBe(1);
  });

  it("never re-consumes a swap whose ring was already recorded", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });

    const res = await runTaproomConsumptionSync(
      fakeSupabaseSwaps([{ source_ref: "sqtransfer:ord-1:line-1", quantity: 1 }], sink), { days: 2 });

    expect(sink.claims).toEqual([]);
    expect(sink.shrinkage).toEqual([]);
    expect(res.swapsConsumed).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it("deducts every keg on a multi-keg ring while booking the outgoing side once", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit({}, { quantity: 2 })], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 2, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 100]]));

    const res = await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 2 }));
    expect(sink.shrinkage).toHaveLength(1);
    expect(res.swapsConsumed).toBe(1);
  });

  it("stamps the claim with the ring's source_ref", async () => {
    const sink = emptySwapSink();
    derive.mockResolvedValue({ units: [transitionUnit()], discrepancies: [] });
    record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["e"], breaks: [], warnings: [] });
    fetchCounts.mockResolvedValue(new Map([["draft-sqvar-old", 0]]));

    await runTaproomConsumptionSync(fakeSupabaseSwaps([], sink), { days: 2 });

    expect(sink.claims).toEqual([{ id: "swap-1", sourceRef: "sqtransfer:ord-1:line-1" }]);
  });
});
