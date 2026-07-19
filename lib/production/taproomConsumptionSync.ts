import { SupabaseClient } from "@supabase/supabase-js";
import { deriveTaproomConsumption, type ConsumptionKind, type AssemblyDiscrepancy } from "@/lib/square/taproomConsumption";
import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { reconcileSquareCanInventory } from "@/lib/production/reconcileSquareCanInventory";
import { syncDraftPourConsumption } from "./syncDraftPourConsumption";

/**
 * Reconciling taproom-consumption sync.
 *
 * Idempotent by design: every run re-derives target consumption from Square and
 * records only `target − already_recorded` per source_ref, bounded by cold-storage
 * on-hand (recordTaproomConsumption never goes negative). Re-running converges —
 * fully-recorded units yield a zero delta; short-stock and unconfigured-draft
 * units stay flagged until their upstream cause is fixed, then self-clear on the
 * next run. Shared by the sync route and the daily cron.
 */

export interface RecordedLine {
  kind: ConsumptionKind;
  recipeId: string;
  variationId: string;
  sourceRef: string;
  label: string;
  recordedQty: number;
}

export type SyncDiscrepancy =
  | AssemblyDiscrepancy
  | {
      kind: "short_stock";
      recipeId: string;
      variationId: string;
      label: string;
      requestedQty: number;
      recordedQty: number;
      shortfallQty: number;
    }
  | {
      kind: "recount_failed";
      sourceRef: string;
      label: string;
      detail: string;
    }
  | {
      kind: "shrinkage_capture_failed";
      sourceRef: string;
      detail: string;
    };

export interface TaproomSyncResult {
  shipmentId: string;
  windowDays: number;
  /** True when another sync run held the lease lock and this run skipped entirely. */
  lockSkipped: boolean;
  recorded: RecordedLine[];
  recordedUnits: number;
  skipped: number;
  totalRecordedQty: number;
  recountsApplied: number;
  packsBrokenDown: number;
  packagingWarnings: string[];
  discrepancies: SyncDiscrepancy[];
  squareWriteback: { applied: number; writes: import("./reconcileSquareCanInventory").ReconcileWrite[]; warnings: string[] };
}

const EPS = 1e-4;

// Serializes concurrent sync runs. The Square webhook fires this sync on every
// order.* event, so one restock's event burst triggers several overlapping runs;
// without a lock they each read "0 already recorded" and write duplicate rows.
// TTL exceeds the longest possible run (cron ≤ Vercel maxDuration) so a live run
// is never stolen; a hard-killed holder self-clears after it.
const LOCK_JOB = "taproom_consumption_sync";
const LOCK_TTL_SECONDS = 300;

/** Remaining units to record for a unit given what's already booked (never negative). */
export function remainingDelta(targetQty: number, alreadyRecorded: number): number {
  const d = targetQty - alreadyRecorded;
  return d > EPS ? d : 0;
}

/** Sum of already-recorded quantity per source_ref (chunked to stay under `in` limits). */
async function recordedByRef(supabase: SupabaseClient, refs: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < refs.length; i += 300) {
    const chunk = refs.slice(i, i + 300);
    const { data, error } = await supabase
      .from("export_transactions")
      .select("source_ref, quantity")
      .in("source_ref", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const ref = row.source_ref as string;
      map.set(ref, (map.get(ref) ?? 0) + Number(row.quantity));
    }
  }
  return map;
}

export async function runTaproomConsumptionSync(
  supabase: SupabaseClient,
  { days }: { days: number },
): Promise<TaproomSyncResult> {
  const shipmentId = crypto.randomUUID();

  // Claim the lease before touching any data. If another run holds it, skip
  // entirely — the trailing window plus the daily cron re-cover anything missed,
  // matching this sync's existing "self-heals on the next trigger" contract.
  const { data: acquired, error: lockErr } = await supabase.rpc("try_acquire_sync_lock", {
    p_job: LOCK_JOB,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (lockErr) throw new Error(`taproom sync lock acquire failed: ${lockErr.message}`);
  if (!acquired) {
    return {
      shipmentId, windowDays: days, lockSkipped: true,
      recorded: [], recordedUnits: 0, skipped: 0, totalRecordedQty: 0,
      recountsApplied: 0, packsBrokenDown: 0, packagingWarnings: [], discrepancies: [],
      squareWriteback: { applied: 0, writes: [], warnings: [] },
    };
  }

  try {
  const { units, discrepancies: configDiscrepancies } = await deriveTaproomConsumption(supabase, { days });

  const refs = [...new Set(units.map((u) => u.sourceRef))];
  const recorded = refs.length ? await recordedByRef(supabase, refs) : new Map<string, number>();

  const recordedLines: RecordedLine[] = [];
  const shortStock: SyncDiscrepancy[] = [];
  const recountWarnings: SyncDiscrepancy[] = [];
  const shrinkageWarnings: SyncDiscrepancy[] = [];
  let skipped = 0;
  let totalRecordedQty = 0;
  let recountsApplied = 0;
  let packsBrokenDown = 0;
  const packagingWarnings = new Set<string>();

  for (const u of units) {
    const alreadyRecorded = recorded.get(u.sourceRef) ?? 0;
    const delta = remainingDelta(u.quantity, alreadyRecorded);
    if (delta <= 0) { skipped++; continue; }

    const res = await recordTaproomConsumption(supabase, {
      shipmentId,
      recipeId: u.recipeId,
      variationId: u.variationId,
      quantity: delta,
      sourceRef: u.sourceRef,
      notes: null,
    });

    // A break that mutated inventory (parent decremented/deleted, child
    // credited) is counted even if nothing ended up recordable afterward
    // (e.g. the topped-up tier still fell short of `delta`).
    packsBrokenDown += res.breaks.length;
    for (const w of res.warnings) packagingWarnings.add(w);

    if (res.recordedQty > EPS) {
      recordedLines.push({
        kind: u.kind,
        recipeId: u.recipeId,
        variationId: u.variationId,
        sourceRef: u.sourceRef,
        label: u.label,
        recordedQty: res.recordedQty,
      });
      totalRecordedQty += res.recordedQty;

    } else {
      skipped++;
    }

    // Restock-driven swaps carry a recount. Fire it once — on the first run
    // that durably records this swap (alreadyRecorded === 0), whether that
    // record was physical, phantom, or both — so the mapped draft SKU is
    // reset to full in Square even when cold storage had nothing to
    // physically deplete. Tying it to a persisted shipment row guarantees
    // fire-once: subsequent runs see alreadyRecorded > 0 and skip.
    // Best-effort: a Square failure is flagged, never fatal.
    if (u.recount && alreadyRecorded === 0 && res.recordedQty + res.shortfallQty > EPS) {
      // Live shrinkage: Square's CALCULATED on-hand (IN_STOCK) for the draft
      // base variation nets pour depletion already, so the value read here —
      // before the recount below overwrites it to full — equals the true fl
      // oz left in the keg at swap time. Only meaningful when physical
      // inventory actually moved this run — a phantom-only swap (no cold
      // storage on hand) never touched the keg, so there's nothing to
      // capture. Best-effort — never fatal, so a read/write failure never
      // blocks the recount.
      if (res.recordedQty > EPS) {
        try {
          const counts = await fetchCurrentCounts([u.recount.squareVariationId]);
          const remaining = counts.get(u.recount.squareVariationId);
          if (remaining !== undefined) {
            const { error } = await supabase.from("draft_swap_shrinkage").upsert({
              source_ref:      u.sourceRef,
              recipe_id:       u.recipeId,
              tap_number:      u.tapNumber ?? null,
              occurred_at:     u.recount.occurredAt,
              remaining_fl_oz: remaining,
              full_fl_oz:      u.recount.quantity,
            }, { onConflict: "source_ref" });
            if (error) throw new Error(error.message);
          }
        } catch (e) {
          shrinkageWarnings.push({
            kind: "shrinkage_capture_failed",
            sourceRef: u.sourceRef,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }

      try {
        await setPhysicalCount(u.recount.squareVariationId, u.recount.quantity, u.recount.occurredAt);
        recountsApplied++;
      } catch (e) {
        recountWarnings.push({
          kind: "recount_failed",
          sourceRef: u.sourceRef,
          label: u.label,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (res.shortfallQty > EPS) {
      shortStock.push({
        kind: "short_stock",
        recipeId: u.recipeId,
        variationId: u.variationId,
        label: u.label,
        requestedQty: delta,
        recordedQty: res.recordedQty,
        shortfallQty: res.shortfallQty,
      });
    }
  }

  // Reflect cold storage back onto Square for every can recipe this run touched.
  // Cold storage trumps: this writes the loose-can total onto each family's base
  // Square variation. Best-effort — a Square failure is logged, never fatal.
  const canRecipeIds = [...new Set(units.filter((u) => u.kind === "can_sale").map((u) => u.recipeId))];
  let squareWriteback = { applied: 0, writes: [] as import("./reconcileSquareCanInventory").ReconcileWrite[], warnings: [] as string[] };
  if (canRecipeIds.length > 0) {
    try {
      const rc = await reconcileSquareCanInventory(supabase, { recipeIds: canRecipeIds });
      squareWriteback = { applied: rc.applied, writes: rc.writes, warnings: rc.warnings };
    } catch (e) {
      squareWriteback.warnings.push(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Populate the operational pour ledger (sell-through / shrinkage lens) for the
  // trailing window. Strictly additive to the accounting write path above and
  // never fatal — a pour-ledger failure is flagged as a warning, not thrown.
  try {
    await syncDraftPourConsumption(supabase, { days });
  } catch (e) {
    packagingWarnings.add(`draft_pour_consumption sync failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    shipmentId,
    windowDays: days,
    lockSkipped: false,
    recorded: recordedLines,
    recordedUnits: recordedLines.length,
    skipped,
    totalRecordedQty: Math.round(totalRecordedQty * 10000) / 10000,
    recountsApplied,
    packsBrokenDown,
    packagingWarnings: [...packagingWarnings],
    discrepancies: [...configDiscrepancies, ...shortStock, ...recountWarnings, ...shrinkageWarnings],
    squareWriteback,
  };
  } finally {
    // Always release, even on throw, so a failed run never wedges the lease for
    // the full TTL. A release failure is logged, not thrown — the TTL is the
    // backstop and we don't want to mask the original error.
    const { error: relErr } = await supabase.rpc("release_sync_lock", { p_job: LOCK_JOB });
    if (relErr) console.error("[taproom-sync] lock release failed", relErr.message);
  }
}
