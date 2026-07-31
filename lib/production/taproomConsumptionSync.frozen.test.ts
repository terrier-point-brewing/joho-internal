import { it, expect, vi } from "vitest";

// Guardrail: asserts a draft_swap still drives the identical export/accounting
// writes after the #155 revert — quantity = whole keg, sourceRef carries the
// sqtransfer: prefix, and the recount fires to full. Proves the accounting
// path (recordTaproomConsumption + setPhysicalCount) is untouched as the
// shrinkage-capture source moves underneath it: ledger reconstruction → Square's
// calculated on-hand → summed pour transactions.
vi.mock("@/lib/square/taproomConsumption", () => ({ deriveTaproomConsumption: vi.fn() }));
vi.mock("@/lib/production/recordTaproomConsumption", () => ({ recordTaproomConsumption: vi.fn() }));
vi.mock("@/lib/square/inventory", () => ({ setPhysicalCount: vi.fn(), fetchCurrentCounts: vi.fn(), fetchPhysicalCounts: vi.fn() }));
vi.mock("@/lib/production/reconcileSquareCanInventory", () => ({ reconcileSquareCanInventory: vi.fn(async () => ({ writes: [], skips: [], warnings: [], applied: 0 })) }));
vi.mock("@/lib/production/syncDraftPourConsumption", () => ({ syncDraftPourConsumption: vi.fn(async () => ({ recipesTouched: 0, rowsUpserted: 0 })) }));

import { runTaproomConsumptionSync } from "./taproomConsumptionSync";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { deriveTaproomConsumption } from "@/lib/square/taproomConsumption";
import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";

const derive = vi.mocked(deriveTaproomConsumption);
const record = vi.mocked(recordTaproomConsumption);
const recount = vi.mocked(setPhysicalCount);
const fetchCounts = vi.mocked(fetchCurrentCounts);

// Same fixture shape as the main sync suite: a "draft_swap" unit carrying a
// whole-keg quantity and a recount target.
const swapUnit = (over: Record<string, unknown> = {}) => ({
  recipeId: "r1", variationId: "pv-keg", quantity: 1,
  sourceRef: "sqtransfer:ord-1:line-1", kind: "draft_swap" as const,
  label: "Vienna · Tap 3 restock · 2026-07-04", tapNumber: 3,
  recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
  ...over,
});

// Fake supabase: no rows already recorded, draft_swap_shrinkage upserts and the
// pour-window anchor advance are no-op sinks, the lease lock is always granted,
// and recipe_square_links returns no rows — so no pour variations resolve and
// shrinkage measurement falls back to Square's on-hand, exactly as it must when
// a recipe has none configured.
function fakeSupabase() {
  return {
    rpc: async (fn: string) => {
      if (fn === "try_acquire_sync_lock") return { data: true, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      if (table === "draft_swap_shrinkage") {
        return { upsert: async () => ({ error: null }) };
      }
      if (table === "tap_assignments") {
        return {
          select: () => ({ then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === "recipe_square_links") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
    },
  } as never;
}

it("draft_swap still records whole-keg consumption and recounts to full (accounting frozen)", async () => {
  derive.mockResolvedValue({ units: [swapUnit()], discrepancies: [] });
  record.mockResolvedValue({ recordedQty: 1, shortfallQty: 0, exportTransactionIds: ["x"], breaks: [], warnings: [] });
  fetchCounts.mockResolvedValue(new Map([["draft-sqvar", 34]]));
  recount.mockResolvedValue(undefined);

  await runTaproomConsumptionSync(fakeSupabase(), { days: 2 });

  expect(recordTaproomConsumption).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ quantity: 1, sourceRef: expect.stringContaining("sqtransfer:") }),
  );
  expect(setPhysicalCount).toHaveBeenCalledWith("draft-sqvar", 660, expect.any(String));
});
