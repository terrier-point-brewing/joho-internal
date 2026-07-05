import { SupabaseClient } from "@supabase/supabase-js";
import { deriveTaproomConsumption, type ConsumptionKind, type AssemblyDiscrepancy } from "@/lib/square/taproomConsumption";
import { setPhysicalCount } from "@/lib/square/inventory";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";

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
    };

export interface TaproomSyncResult {
  shipmentId: string;
  windowDays: number;
  recorded: RecordedLine[];
  recordedUnits: number;
  skipped: number;
  totalRecordedQty: number;
  recountsApplied: number;
  discrepancies: SyncDiscrepancy[];
}

const EPS = 1e-4;

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
  const { units, discrepancies: configDiscrepancies } = await deriveTaproomConsumption(supabase, { days });

  const refs = [...new Set(units.map((u) => u.sourceRef))];
  const recorded = refs.length ? await recordedByRef(supabase, refs) : new Map<string, number>();

  const shipmentId = crypto.randomUUID();
  const recordedLines: RecordedLine[] = [];
  const shortStock: SyncDiscrepancy[] = [];
  const recountWarnings: SyncDiscrepancy[] = [];
  let skipped = 0;
  let totalRecordedQty = 0;
  let recountsApplied = 0;

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

      // Restock-driven swaps carry a recount. Fire it once — on the first run
      // that durably records this swap (alreadyRecorded === 0) — so the mapped
      // draft SKU is reset to full in Square. Tying it to a persisted shipment
      // row guarantees fire-once: subsequent runs see alreadyRecorded > 0 and
      // skip. Best-effort: a Square failure is flagged, never fatal.
      if (u.recount && alreadyRecorded === 0) {
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
    } else {
      skipped++;
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

  return {
    shipmentId,
    windowDays: days,
    recorded: recordedLines,
    recordedUnits: recordedLines.length,
    skipped,
    totalRecordedQty: Math.round(totalRecordedQty * 10000) / 10000,
    recountsApplied,
    discrepancies: [...configDiscrepancies, ...shortStock, ...recountWarnings],
  };
}
