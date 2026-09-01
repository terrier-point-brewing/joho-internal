import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AllocationChannel,
  type AllocationInput,
  type BatchInput,
  type ShipmentCandidate,
} from "./allocationReserve";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface ShipReserveContext {
  candidates: ShipmentCandidate[];
  batches: BatchInput[];
}

/**
 * Read-only: loads the crediting candidates (this partner's allocations for the
 * recipe — contract first, then soft, oldest batch first) and the per-batch
 * reserve state for every batch the shipment credits or physically draws from
 * (all partners' contract claims on those batches count toward the reserve).
 *
 * The caller supplies the drawn batch ids — the real depletion result for the
 * Ship route, a simulated draw for the Preview route — so the two share identical
 * reserve math and can never diverge.
 */
export async function loadShipReserveContext(
  supabase: SupabaseClient,
  { recipeId, partnerId, drawnBatchIds }: { recipeId: string; partnerId: string; drawnBatchIds: string[] }
): Promise<ShipReserveContext> {
  // Creditable channels only: taproom is internal, and safety_stock is a hold —
  // neither may absorb a partner shipment, and neither channel can be invoiced
  // (exportInvoicePreview throws on anything but contract/distribution/wholesale),
  // so a row stamped with one would be permanently unbillable.
  const { data: allocRows } = await supabase
    .from("batch_allocations")
    .select(`
      id, batch_id, channel, partner_id, percentage, contract_request_id, written_off_at,
      commitments(volume_bbl),
      brew_batches!inner(id, recipe_id, created_at, status)
    `)
    .eq("partner_id", partnerId)
    .in("channel", ["contract_brewing", "distribution", "wholesale"])
    .eq("brew_batches.recipe_id", recipeId);

  const reserveBatchIds = [...new Set([
    ...(allocRows ?? []).map((a) => a.batch_id as string),
    ...drawnBatchIds,
  ])];
  const inList = reserveBatchIds.length ? reserveBatchIds : [ZERO_UUID];

  const { data: reserveAllocRows } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id, written_off_at, commitments(volume_bbl)")
    .in("batch_id", inList)
    .neq("channel", "taproom");

  // produced = sum(volume_bbl) of kegging/canning (net fill, NOT minus shrinkage)
  const { data: prodTransfers } = await supabase
    .from("batch_transfers")
    .select("batch_id, volume_bbl")
    .in("batch_id", inList)
    .in("transfer_type", ["kegging", "canning"]);
  const producedByBatch: Record<string, number> = {};
  for (const t of prodTransfers ?? []) {
    producedByBatch[t.batch_id] = (producedByBatch[t.batch_id] ?? 0) + Number(t.volume_bbl);
  }

  const { data: priorExports } = await supabase
    .from("export_transactions")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", inList);
  const totalExportedByBatch: Record<string, number> = {};
  const exportedByKey: Record<string, number> = {};
  for (const e of priorExports ?? []) {
    totalExportedByBatch[e.batch_id] = (totalExportedByBatch[e.batch_id] ?? 0) + Number(e.volume_bbl);
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedByKey[key] = (exportedByKey[key] ?? 0) + Number(e.volume_bbl);
  }

  const { data: batchRows } = await supabase.from("brew_batches").select("id, status").in("id", inList);
  const statusById = new Map((batchRows ?? []).map((b) => [b.id as string, b.status as string]));

  type ReserveAllocRow = { id: string; batch_id: string; channel: string; partner_id: string | null; percentage: number; written_off_at: string | null; commitments: { volume_bbl: number } | null };
  const allocInput = (r: ReserveAllocRow): AllocationInput => {
    const channel = r.channel as AllocationChannel;
    const key = `${r.batch_id}:${r.channel}:${r.partner_id ?? ""}`;
    return {
      id: r.id,
      batchId: r.batch_id,
      channel,
      percentage: Number(r.percentage),
      bookedBbl: channel === "contract_brewing" ? (r.commitments?.volume_bbl ?? null) : null,
      exportedBbl: exportedByKey[key] ?? 0,
      writtenOff: !!r.written_off_at,
    };
  };
  const allocsByBatch = new Map<string, AllocationInput[]>();
  for (const r of (reserveAllocRows ?? []) as unknown as ReserveAllocRow[]) {
    const list = allocsByBatch.get(r.batch_id) ?? [];
    list.push(allocInput(r));
    allocsByBatch.set(r.batch_id, list);
  }
  const batches: BatchInput[] = reserveBatchIds.map((bid) => ({
    batchId: bid,
    producedBbl: producedByBatch[bid] ?? 0,
    totalExportedBbl: totalExportedByBatch[bid] ?? 0,
    status: statusById.get(bid) ?? "",
    allocations: allocsByBatch.get(bid) ?? [],
  }));

  type CandRow = { id: string; batch_id: string; channel: string; percentage: number; written_off_at: string | null; commitments: { volume_bbl: number } | null; brew_batches: { created_at: string } };
  const candidates: ShipmentCandidate[] = ((allocRows ?? []) as unknown as CandRow[])
    // A written-off allocation is closed — never credit new shipments to it.
    .filter((a) => !a.written_off_at)
    .map((a) => {
      const channel = a.channel as AllocationChannel;
      const exported = exportedByKey[`${a.batch_id}:${a.channel}:${partnerId}`] ?? 0;
      const booked = channel === "contract_brewing" ? (a.commitments?.volume_bbl ?? 0) : null;
      const bookedRemainingBbl = channel === "contract_brewing" ? Math.max(0, (booked ?? 0) - exported) : null;
      // What the batch has actually made for this allocation, less what already
      // shipped. Caps the credit alongside booked so a batch that finished below
      // its booked estimate (shrinkage) cannot keep absorbing other batches' beer.
      const realizable = (Number(a.percentage) / 100) * (producedByBatch[a.batch_id] ?? 0);
      const realizableRemainingBbl = channel === "contract_brewing" ? Math.max(0, realizable - exported) : null;
      return { allocationId: a.id, batchId: a.batch_id, channel, bookedRemainingBbl, realizableRemainingBbl, _createdAt: a.brew_batches.created_at };
    })
    // Drop contract allocations with nothing left to credit — on either cap.
    .filter((c) =>
      c.channel === "contract_brewing"
        ? (c.bookedRemainingBbl ?? 0) > 0.0001 && (c.realizableRemainingBbl ?? 0) > 0.0001
        : true
    )
    .sort((x, y) => {
      const cx = x.channel === "contract_brewing" ? 0 : 1;
      const cy = y.channel === "contract_brewing" ? 0 : 1;
      if (cx !== cy) return cx - cy;
      return new Date(x._createdAt).getTime() - new Date(y._createdAt).getTime();
    })
    .map(({ allocationId, batchId, channel, bookedRemainingBbl, realizableRemainingBbl }) => ({ allocationId, batchId, channel, bookedRemainingBbl, realizableRemainingBbl }));

  return { candidates, batches };
}

/**
 * Simulate the cold-storage FIFO draw (oldest row first) for a prospective
 * shipment WITHOUT mutating anything — used by the ship preview so it can show
 * the same per-batch coverage warnings the real ship would raise.
 */
export async function simulateColdStorageDraw(
  supabase: SupabaseClient,
  { recipeId, variationId, quantity, bblPerUnit }: { recipeId: string; variationId: string; quantity: number; bblPerUnit: number }
): Promise<{ perBatchDrawBbl: { batchId: string; drawBbl: number }[]; availableUnits: number }> {
  const { data: rows } = await supabase
    .from("cold_storage_inventory")
    .select("batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId)
    .order("created_at", { ascending: true });

  const availableUnits = (rows ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
  const drawByBatch: Record<string, number> = {};
  let left = quantity;
  for (const r of rows ?? []) {
    if (left <= 0) break;
    const take = Math.min(Number(r.quantity_on_hand), left);
    if (take <= 0) continue;
    drawByBatch[r.batch_id] = (drawByBatch[r.batch_id] ?? 0) + take;
    left -= take;
  }
  const perBatchDrawBbl = Object.entries(drawByBatch).map(([batchId, units]) => ({ batchId, drawBbl: units * bblPerUnit }));
  return { perBatchDrawBbl, availableUnits };
}
