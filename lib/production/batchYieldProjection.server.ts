import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPackagingYieldPct, projectBatchYield } from "./exportIngredientDeposit";
import type { LedgerTransfer } from "./volumeLedger";

/**
 * How much beer a batch makes — the number every share is a percentage OF.
 *
 * Packaging happens for one partner at a time: B-033 canned 12.9 bbl for
 * Argus and shipped 8.1 of it while 27 bbl of the same batch sat in tank for
 * the taproom and Fortnight. Measured against "packaged so far", Argus's 75%
 * was 9.7 bbl and the shipment read as over-delivery; measured against what
 * the batch will make, it was well inside their share. So while a batch is
 * still in tank a share is a percentage of its PROJECTED yield (packaged so
 * far plus the in-tank volume at the house packaging yield — the deposit
 * invoice's denominator, lib/production/exportIngredientDeposit). Once the
 * batch is complete nothing more is coming and the projection collapses to
 * what was packaged, which is where shrinkage finally lands on everyone.
 *
 * One loader for the ship planner, the re-home planner, the Partner Ledger
 * and Intake → Commitments, so none of them can disagree about a share.
 */
export interface BatchYield {
  /** kegging + canning net fill — measured, never typed. */
  producedBbl: number;
  /**
   * produced once complete; otherwise produced plus what the tank is expected
   * to package out at. Never below produced.
   */
  projectedBbl: number;
  complete: boolean;
}

export async function loadBatchYields(
  supabase: SupabaseClient,
  batchIds: string[],
): Promise<Map<string, BatchYield>> {
  const out = new Map<string, BatchYield>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;

  const [{ data: batches }, { data: transfers }, { data: equipment }, packagingYieldPct] = await Promise.all([
    supabase.from("brew_batches").select("id, status, volume_bbl").in("id", ids),
    // Both sides of every transfer: a conversion child's liquid arrives as a
    // to_batch_id row, and the location breakdown needs to see it land.
    supabase.from("batch_transfers")
      .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
      .or(`batch_id.in.(${ids.join(",")}),to_batch_id.in.(${ids.join(",")})`),
    supabase.from("equipment").select("id, type"),
    loadPackagingYieldPct(supabase),
  ]);

  const ledger = (transfers ?? []) as Array<LedgerTransfer & { transfer_type: string }>;
  const tankTypeById: Record<string, string> = {};
  for (const e of (equipment ?? []) as Array<{ id: string; type: string }>) tankTypeById[e.id] = e.type;

  for (const b of (batches ?? []) as Array<{ id: string; status: string | null; volume_bbl: number | null }>) {
    const proj = projectBatchYield(b.id, Number(b.volume_bbl ?? 0), ledger, tankTypeById, packagingYieldPct);
    const complete = b.status === "complete";
    out.set(b.id, {
      producedBbl: proj.packagedBbl,
      projectedBbl: complete ? proj.packagedBbl : Math.max(proj.packagedBbl, proj.projectedYieldBbl),
      complete,
    });
  }
  return out;
}

/** The yield a share is measured against, for one batch; 0 when unknown. */
export function shareBasisBbl(yields: Map<string, BatchYield>, batchId: string): number {
  return yields.get(batchId)?.projectedBbl ?? 0;
}
