import { SupabaseClient } from "@supabase/supabase-js";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { fetchGroupDraw, fetchGroupLots, orderGroupByAge } from "@/lib/production/coldStorageGroupDraw";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { writePhantomExport, type PhantomOrigin } from "@/lib/production/writePhantomExport";
import { applyBreakDown, type AppliedBreak } from "@/lib/production/applyBreakDown";

export interface RecordTaproomConsumptionParams {
  shipmentId?: string;
  recipeId: string;
  variationId: string;
  /**
   * Every packaging variation behind a fungible Square SKU, including
   * `variationId` — see square_fungible_skus. Two or more members switch on the
   * group draw: the sale is filled oldest-lot-first across all of them, one
   * export row per variation actually drawn from.
   *
   * Omitted, empty, or a single member keeps the original single-variation path
   * untouched, which is the overwhelmingly common case.
   */
  variationIds?: string[];
  quantity: number;        // target units to record
  sourceRef: string;       // idempotency key stamped onto the export transactions
  notes?: string | null;
  /**
   * Which Square consumption kind is being recorded. Only reaches the database
   * on a shortfall, where it is stamped onto the phantom row — this function
   * serves draft swaps, keg sales and can sales alike, and the phantom is the
   * one output that cannot be told apart afterwards without it.
   */
  kind: PhantomOrigin;
}

const EPS = 1e-4;

/**
 * Tolerant taproom-channel recorder used by the Square sync. Records as much of
 * the requested `quantity` as cold storage can currently cover via a physical
 * shipment, and books any remaining shortfall as a batch-less phantom export
 * so barrel excise is never silently dropped — cold storage is never depleted
 * below zero. The physical and phantom rows (when both are written) share one
 * `shipment_id` grouping UUID.
 *
 * `available` (and therefore `recordedQty`/`shortfallQty`) can be fractional —
 * they stay numeric with no forced integer rounding.
 */
export async function recordTaproomConsumption(
  supabase: SupabaseClient,
  params: RecordTaproomConsumptionParams,
): Promise<{ recordedQty: number; shortfallQty: number; exportTransactionIds: string[]; breaks: AppliedBreak[]; warnings: string[] }> {
  const { recipeId, variationId, quantity } = params;

  // A declared group takes the multi-variation path. The single-variation path
  // below is left exactly as it was rather than expressed as a group of one:
  // it is the path every sale in the system has taken to date, and there is
  // nothing to gain from re-routing it through new code.
  const group = params.variationIds ?? [];
  if (group.length > 1) return recordAcrossGroup(supabase, params, group);

  let available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });

  // Short on this tier? Break down higher tiers of the same can identity to top it
  // up (case->pack->single, smallest-first). Only the taproom path breaks; sealed
  // wholesale stock is never auto-cracked. No-op for kegs / no-higher-tier cans.
  let breaks: AppliedBreak[] = [];
  let warnings: string[] = [];
  if (available < quantity - EPS) {
    const bd = await applyBreakDown(supabase, { recipeId, variationId, needed: quantity, sourceRef: params.sourceRef });
    breaks = bd.applied;
    warnings = bd.warnings;
    if (bd.applied.length > 0) {
      available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });
    }
  }

  const recordable = Math.min(quantity, available);
  const shortfall = quantity - recordable;

  const exportTransactionIds: string[] = [];
  let shipmentId = params.shipmentId;

  if (recordable > 0) {
    const result = await writeColdStorageShipment(supabase, {
      shipmentId,
      channel: "taproom",
      recipeId,
      variationId,
      quantity: recordable,
      recipientId: null,
      recipientName: null,
      allocationId: null,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
    });
    shipmentId = result.shipmentId;
    exportTransactionIds.push(...result.exportTransactionIds);
  }

  if (shortfall > EPS) {
    const phantom = await writePhantomExport(supabase, {
      shipmentId,
      recipeId,
      variationId,
      quantityKegs: shortfall,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
      origin: params.kind,
    });
    exportTransactionIds.push(phantom.exportTransactionId);
  }

  return { recordedQty: recordable, shortfallQty: shortfall, exportTransactionIds, breaks, warnings };
}

/**
 * Fill one sale from a fungible Square SKU's whole group of packaging
 * variations, oldest cold-storage lot first.
 *
 * Two passes, in that order for a reason:
 *
 *   1. Draw what is already on hand across the group, oldest lot first. This is
 *      the ordinary case and it never breaks anything open.
 *   2. Only once the group's on-hand is exhausted, crack higher tiers — trying
 *      members in the order of their oldest stock, so the oldest cases go first
 *      too. Nothing older than what pass 1 took can appear here, so a member's
 *      freshly-cracked units are drawn immediately rather than re-sorted against
 *      the group.
 *
 * Whatever survives both passes is a real shortfall and becomes a phantom
 * export, exactly as in the single-variation path — cold storage is never driven
 * negative, and the barrelage is never silently dropped.
 *
 * Every physical write goes through writeColdStorageShipment once per variation,
 * so each export row carries that variation's own volume, units-per-package,
 * container and packaging-loss. The sale is shared; the beer that left is not.
 */
async function recordAcrossGroup(
  supabase: SupabaseClient,
  params: RecordTaproomConsumptionParams,
  group: string[],
): Promise<{ recordedQty: number; shortfallQty: number; exportTransactionIds: string[]; breaks: AppliedBreak[]; warnings: string[] }> {
  const { recipeId, quantity } = params;

  const exportTransactionIds: string[] = [];
  const breaks: AppliedBreak[] = [];
  const warnings = new Set<string>();
  let shipmentId = params.shipmentId;
  let remaining = quantity;

  /**
   * The variation a shortfall is charged to. Set to whichever member was drawn
   * from LAST — the one that was actually running out when the sale outran the
   * stock. Falls back to the link's own variation when the group was already
   * empty and nothing was drawn at all.
   */
  let lastDrawnVariationId: string | null = null;

  async function draw(variationId: string, qty: number): Promise<void> {
    const result = await writeColdStorageShipment(supabase, {
      shipmentId,
      channel: "taproom",
      recipeId,
      variationId,
      quantity: qty,
      recipientId: null,
      recipientName: null,
      allocationId: null,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
    });
    shipmentId = result.shipmentId;
    exportTransactionIds.push(...result.exportTransactionIds);
    remaining -= qty;
    lastDrawnVariationId = variationId;
  }

  // ── Pass 1: on-hand, oldest lot first ──────────────────────────────────────
  const planned = await fetchGroupDraw(supabase, { recipeId, variationIds: group, quantity: remaining });
  for (const slice of planned.slices) {
    if (slice.quantity <= EPS) continue;
    await draw(slice.variationId, slice.quantity);
  }

  // ── Pass 2: crack higher tiers, oldest member first ────────────────────────
  if (remaining > EPS) {
    const lots = await fetchGroupLots(supabase, { recipeId, variationIds: group });
    for (const memberId of orderGroupByAge(lots, group)) {
      if (remaining <= EPS) break;
      const bd = await applyBreakDown(supabase, {
        recipeId,
        variationId: memberId,
        needed: remaining,
        sourceRef: params.sourceRef,
      });
      breaks.push(...bd.applied);
      for (const w of bd.warnings) warnings.add(w);
      if (bd.applied.length === 0) continue;

      const available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId: memberId });
      const take = Math.min(available, remaining);
      if (take > EPS) await draw(memberId, take);
    }
  }

  // ── Whatever is still owed left with no stock behind it ────────────────────
  if (remaining > EPS) {
    const phantom = await writePhantomExport(supabase, {
      shipmentId,
      recipeId,
      variationId: lastDrawnVariationId ?? params.variationId,
      quantityKegs: remaining,
      sourceRef: params.sourceRef,
      notes: params.notes ?? null,
      origin: params.kind,
    });
    exportTransactionIds.push(phantom.exportTransactionId);
  }

  const shortfallQty = remaining > EPS ? remaining : 0;
  return {
    recordedQty: quantity - shortfallQty,
    shortfallQty,
    exportTransactionIds,
    breaks,
    warnings: [...warnings],
  };
}
