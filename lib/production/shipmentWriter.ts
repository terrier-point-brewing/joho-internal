import { SupabaseClient } from "@supabase/supabase-js";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { planShipment, planCreditedWrites, type PlannedWrite, type ShipmentWarning } from "@/lib/production/allocationReserve";
import { loadShipReserveContext } from "@/lib/production/shipReserveContext";

/**
 * Quantity-weighted packaging loss % per batch for one variation, taken from the
 * canning runs that produced it. Weighted because a batch can be canned across
 * several runs at different rates; a run with no recorded loss weighs in at 0
 * rather than being skipped, so it correctly dilutes the average. Batches with
 * no canning history (kegs, or pre-migration rows) are simply absent from the
 * map and default to 0 at the call site.
 */
export async function resolvePackagingLossByBatch(
  supabase: SupabaseClient,
  { variationId, batchIds }: { variationId: string; batchIds: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (batchIds.length === 0) return out;

  const { data: runs } = await supabase
    .from("batch_transfers")
    .select("batch_id, quantity, packaging_loss_pct")
    .eq("variation_id", variationId)
    .eq("transfer_type", "canning")
    .in("batch_id", batchIds);

  const totals = new Map<string, { weighted: number; qty: number }>();
  for (const r of runs ?? []) {
    const qty = Number(r.quantity ?? 0);
    if (qty <= 0) continue;
    const acc = totals.get(r.batch_id) ?? { weighted: 0, qty: 0 };
    acc.weighted += Number(r.packaging_loss_pct ?? 0) * qty;
    acc.qty      += qty;
    totals.set(r.batch_id, acc);
  }
  for (const [batchId, { weighted, qty }] of totals) {
    if (qty > 0) out.set(batchId, Math.round((weighted / qty) * 1000) / 1000);
  }
  return out;
}

export interface WriteColdStorageShipmentParams {
  shipmentId?: string;                 // default crypto.randomUUID()
  channel: string;                     // 'taproom' | 'distribution' | 'contract_brewing' | 'wholesale'
  recipeId: string;
  variationId: string;
  quantity: number;                    // caller GUARANTEES quantity <= available on hand
  recipientId?: string | null;
  recipientName?: string | null;
  allocationId?: string | null;        // physical mode: stamp this allocation on every row
  sourceRef?: string | null;
  notes?: string | null;
  /**
   * Crediting mode selector. Omit (or null) for a flat, allocation-agnostic
   * shipment — one row per physically drained batch, stamped with the passed
   * `channel`/`allocationId` (used by ad-hoc export and taproom consumption).
   * Set `{ partnerId }` to CREDIT that partner's allocations instead: contract up
   * to its booked deposit, soft absorbs the remainder, anything beyond booked is
   * recorded as a flagged over-delivery row — and the reserve warnings are
   * returned. Channel policy (contract vs soft) lives in the pure `planShipment`;
   * this writer never branches on channel.
   */
  credit?: { partnerId: string } | null;
}

export interface WriteColdStorageShipmentResult {
  shipmentId: string;
  depleted: { batchId: string; depletedQty: number }[];
  exportTransactionIds: string[];
  created: { batch_id: string; export_transaction_id: string }[];
  warnings: ShipmentWarning[];
}

/**
 * The single cold-storage shipment writer. Depletes cold_storage_inventory
 * oldest-first, breaks the drained volume into export rows, writes them, and
 * completes exhausted batches. The ONLY thing that varies by mode is how the
 * drained volume is split into rows (see `credit`); deplete → write → complete →
 * fulfill is shared. Every path lands in the same `export_transactions` ledger.
 *
 * The caller GUARANTEES `quantity` does not exceed the quantity on hand —
 * depletion does not re-check availability.
 *
 * In physical mode (`credit` omitted) `exportTransactionIds[i]` is index-aligned
 * with `depleted[i]` (one row per drained batch). In crediting mode the rows
 * follow the allocation credits, not the drained rows, so use `created`/`warnings`.
 */
export async function writeColdStorageShipment(
  supabase: SupabaseClient,
  params: WriteColdStorageShipmentParams
): Promise<WriteColdStorageShipmentResult> {
  const {
    channel, recipeId, variationId, quantity,
    recipientId = null, recipientName = null, allocationId = null,
    sourceRef = null, notes = null, credit = null,
  } = params;
  const shipmentId = params.shipmentId ?? crypto.randomUUID();

  // ── Resolve variation → volume + display name + container item id ─────────
  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name, format, tray_id, paktech_id")
    .eq("id", variationId)
    .single();
  if (varErr) throw new Error(varErr.message);
  if (!variation) throw new Error("Variation not found.");
  const unitsPerPackage = await getUnitsPerPackage(supabase, {
    format: variation.format, tray_id: variation.tray_id, paktech_id: variation.paktech_id,
  });
  const bblPerUnit = variation.total_volume_fl_oz / BBL_TO_FL_OZ;

  // ── Deplete cold_storage_inventory, oldest row first ──────────────────────
  const depleted = await depleteColdStorageInventory(supabase, { recipeId, variationId, quantity });

  // ── Packaging loss inherited from the canning run(s) ──────────────────────
  // Cans are billed for the materials they actually consumed, spoilage included,
  // so the invoice matches the inventory deduction. Resolved per batch because
  // two batches of the same variation can have been canned at different rates.
  // Kegs never carry a loss.
  const lossPctByBatch = await resolvePackagingLossByBatch(supabase, {
    variationId,
    batchIds: depleted.map((d) => d.batchId),
  });

  // ── Break the drained volume into rows (the one place the modes differ) ────
  let writes: PlannedWrite[];
  let warnings: ShipmentWarning[] = [];

  if (credit) {
    const perBatchDrawBbl = depleted.map((d) => ({ batchId: d.batchId, drawBbl: d.depletedQty * bblPerUnit }));
    const { candidates, batches } = await loadShipReserveContext(supabase, {
      recipeId, partnerId: credit.partnerId, drawnBatchIds: depleted.map((d) => d.batchId),
    });
    const plan = planShipment({ requestedBbl: quantity * bblPerUnit, candidates, perBatchDrawBbl, batches });
    // Over-delivery falls back to the passed channel when the partner has no
    // creditable allocation to borrow a channel from.
    const overDeliveryChannel =
      candidates.find((c) => c.channel === "contract_brewing")?.channel
      ?? candidates[0]?.channel
      ?? channel;
    writes = planCreditedWrites(plan, { candidates, depleted, quantity, overDeliveryChannel });
    warnings = plan.warnings;
  } else {
    // Flat physical attribution: one row per drained batch.
    writes = depleted.map((d) => ({
      batchId: d.batchId,
      allocationId,
      channel,
      bbl: (d.depletedQty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ,
      qty: d.depletedQty,
      overAllocation: false,
    }));
  }

  // ── Write rows, complete exhausted batches, fulfill credited commitments ──
  const exportTransactionIds: string[] = [];
  const created: { batch_id: string; export_transaction_id: string }[] = [];
  const completedBatches = new Set<string>();

  for (const w of writes) {
    const exportTxId = await writeExportTransaction(supabase, {
      shipmentId,
      batchId: w.batchId,
      recipeId,
      packagingItemId: variation.container_id,
      variantLabel: variation.name,
      quantity: w.qty,
      volumeBbl: w.bbl,
      channel: w.channel,
      recipientId,
      recipientName,
      allocationId: w.allocationId,
      notes,
      packagingFormat: variation.format,
      unitsPerPackage,
      sourceRef,
      overAllocation: w.overAllocation,
      packagingLossPct: lossPctByBatch.get(w.batchId) ?? 0,
    });

    if (!completedBatches.has(w.batchId)) {
      await checkAndCompleteBatch(supabase, w.batchId);
      completedBatches.add(w.batchId);
    }
    if (w.allocationId) await checkAndFulfillCommitment(supabase, w.allocationId);

    exportTransactionIds.push(exportTxId);
    created.push({ batch_id: w.batchId, export_transaction_id: exportTxId });
  }

  return { shipmentId, depleted, exportTransactionIds, created, warnings };
}
