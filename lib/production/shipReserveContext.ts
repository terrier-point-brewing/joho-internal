import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AllocationChannel,
  type AllocationInput,
  type BatchInput,
  type ShipmentCandidate,
} from "./allocationReserve";
import { sumExportedByAllocation, type ExportVolumeRow } from "./allocationDelivery";
import { planShipment, type ShipmentPlan } from "./allocationReserve";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { listHomes, type HomesForBatch } from "./rehome";

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
      id, batch_id, channel, partner_id, percentage, contract_request_id, written_off_at, invoice_paid_at,
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

  // Credited volume is read by allocation_id — the unit of record. Rows with
  // no allocation (over-delivery, ad-hoc) still count against the batch total.
  const { data: priorExports } = await supabase
    .from("export_transactions")
    .select("batch_id, allocation_id, volume_bbl")
    .in("batch_id", inList);
  const totalExportedByBatch: Record<string, number> = {};
  for (const e of priorExports ?? []) {
    totalExportedByBatch[e.batch_id] = (totalExportedByBatch[e.batch_id] ?? 0) + Number(e.volume_bbl);
  }
  const exportedByAllocation = sumExportedByAllocation((priorExports ?? []) as ExportVolumeRow[]);

  const { data: batchRows } = await supabase.from("brew_batches").select("id, status").in("id", inList);
  const statusById = new Map((batchRows ?? []).map((b) => [b.id as string, b.status as string]));

  type ReserveAllocRow = { id: string; batch_id: string; channel: string; partner_id: string | null; percentage: number; written_off_at: string | null; commitments: { volume_bbl: number } | null };
  const allocInput = (r: ReserveAllocRow): AllocationInput => {
    const channel = r.channel as AllocationChannel;
    return {
      id: r.id,
      batchId: r.batch_id,
      channel,
      percentage: Number(r.percentage),
      bookedBbl: channel === "contract_brewing" ? (r.commitments?.volume_bbl ?? null) : null,
      exportedBbl: exportedByAllocation.get(r.id) ?? 0,
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

  type CandRow = { id: string; batch_id: string; channel: string; percentage: number; written_off_at: string | null; invoice_paid_at: string | null; commitments: { volume_bbl: number } | null; brew_batches: { created_at: string } };
  const candidates: ShipmentCandidate[] = ((allocRows ?? []) as unknown as CandRow[])
    // A written-off allocation is closed — never credit new shipments to it.
    .filter((a) => !a.written_off_at)
    .map((a) => {
      const channel = a.channel as AllocationChannel;
      const exported = exportedByAllocation.get(a.id) ?? 0;
      const booked = channel === "contract_brewing" ? (a.commitments?.volume_bbl ?? 0) : null;
      const bookedRemainingBbl = channel === "contract_brewing" ? Math.max(0, (booked ?? 0) - exported) : null;
      // What the batch has actually made for this allocation, less what already
      // shipped. Caps the credit alongside booked so a batch that finished below
      // its booked estimate (shrinkage) cannot keep absorbing other batches' beer.
      const realizable = (Number(a.percentage) / 100) * (producedByBatch[a.batch_id] ?? 0);
      const realizableRemainingBbl = Math.max(0, realizable - exported);
      const depositSettled = channel === "contract_brewing" ? !!a.invoice_paid_at : undefined;
      return { allocationId: a.id, batchId: a.batch_id, channel, bookedRemainingBbl, realizableRemainingBbl, depositSettled, _createdAt: a.brew_batches.created_at };
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
    .map(({ allocationId, batchId, channel, bookedRemainingBbl, realizableRemainingBbl, depositSettled }) => ({ allocationId, batchId, channel, bookedRemainingBbl, realizableRemainingBbl, depositSettled }));

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

/**
 * Contract allocations of this partner + recipe that a shipment would credit
 * (something still owed) whose ingredient deposit has not been paid. The ship
 * route refuses without an acknowledgement; the preview shows them up front.
 */
export async function unpaidDepositBatches(
  supabase: SupabaseClient,
  { recipeId, partnerId }: { recipeId: string; partnerId: string },
): Promise<Array<{ batchId: string; batchNumber: string | null; allocationId: string }>> {
  const { candidates } = await loadShipReserveContext(supabase, { recipeId, partnerId, drawnBatchIds: [] });
  const unpaid = candidates.filter((c) => c.channel === "contract_brewing" && c.depositSettled === false);
  if (unpaid.length === 0) return [];
  const { data: batches } = await supabase
    .from("brew_batches")
    .select("id, batch_number")
    .in("id", unpaid.map((c) => c.batchId));
  const numberById = new Map(((batches ?? []) as Array<{ id: string; batch_number: string | null }>).map((b) => [b.id, b.batch_number]));
  return unpaid.map((c) => ({ batchId: c.batchId, batchNumber: numberById.get(c.batchId) ?? null, allocationId: c.allocationId }));
}

export interface SimulatedShipment {
  plan: ShipmentPlan;
  candidates: ShipmentCandidate[];
  batches: BatchInput[];
  perBatchDrawBbl: { batchId: string; drawBbl: number }[];
  requestedBbl: number;
  lines: { variation_id: string; requested: number; available: number; insufficient: boolean }[];
  /** bbl the plan could not credit to any of the partner's allocations. */
  overBbl: number;
  /** The partner has no creditable allocation for this beer at all. */
  noCommitment: boolean;
  /**
   * Where the over-delivered bbl could take its share from, on the batch the
   * partner's contract allocation sits on (first contract candidate, else the
   * first drawn batch). Null when nothing is over.
   */
  over: { bbl: number; targetAllocationId: string | null; homes: HomesForBatch } | null;
}

/**
 * Plan a prospective shipment end to end WITHOUT writing: availability per
 * line, the simulated FIFO draw, the credit plan, and — when the partner
 * would be shipped more than they are booked for — where that beer could be
 * given a home. Shared by the ship preview and the ship route so the two
 * can never disagree about whether a shipment needs a home first.
 */
export async function simulateShipment(
  supabase: SupabaseClient,
  { recipeId, partnerId, lines }: { recipeId: string; partnerId: string; lines: { variation_id: string; quantity: number }[] },
): Promise<SimulatedShipment> {
  const { data: variations } = await supabase
    .from("packaging_variations")
    .select("id, total_volume_fl_oz")
    .in("id", lines.map((l) => l.variation_id));
  const volumeById = new Map((variations ?? []).map((v) => [v.id as string, Number(v.total_volume_fl_oz)]));

  let requestedBbl = 0;
  const mergedDraw = new Map<string, number>();
  const lineAvailability: SimulatedShipment["lines"] = [];
  for (const line of lines) {
    const totalFlOz = volumeById.get(line.variation_id);
    if (totalFlOz == null) throw new Error("Variation not found.");
    const bblPerUnit = totalFlOz / BBL_TO_FL_OZ;
    requestedBbl += line.quantity * bblPerUnit;
    const { perBatchDrawBbl, availableUnits } = await simulateColdStorageDraw(supabase, {
      recipeId, variationId: line.variation_id, quantity: line.quantity, bblPerUnit,
    });
    for (const d of perBatchDrawBbl) mergedDraw.set(d.batchId, (mergedDraw.get(d.batchId) ?? 0) + d.drawBbl);
    lineAvailability.push({ variation_id: line.variation_id, requested: line.quantity, available: availableUnits, insufficient: line.quantity > availableUnits });
  }
  const perBatchDrawBbl = [...mergedDraw].map(([batchId, drawBbl]) => ({ batchId, drawBbl }));

  const { candidates, batches } = await loadShipReserveContext(supabase, {
    recipeId, partnerId, drawnBatchIds: perBatchDrawBbl.map((d) => d.batchId),
  });
  const plan = planShipment({ requestedBbl, candidates, perBatchDrawBbl, batches });
  const overBbl = Math.round(plan.credits.filter((c) => c.allocationId == null).reduce((s, c) => s + c.bbl, 0) * 10000) / 10000;

  // "No commitment" means no allocation of any creditable channel for this
  // partner + recipe, not merely none with credit left.
  const { count } = await supabase
    .from("batch_allocations")
    .select("id, brew_batches!inner(recipe_id)", { count: "exact", head: true })
    .eq("partner_id", partnerId)
    .in("channel", ["contract_brewing", "distribution", "wholesale"])
    .eq("brew_batches.recipe_id", recipeId);
  const noCommitment = (count ?? 0) === 0;

  let over: SimulatedShipment["over"] = null;
  if (overBbl > 1e-4 && !noCommitment) {
    const target = candidates.find((c) => c.channel === "contract_brewing") ?? candidates[0] ?? null;
    let targetAllocationId: string | null = target?.allocationId ?? null;
    let batchId: string | null = target?.batchId ?? perBatchDrawBbl[0]?.batchId ?? null;
    if (!target) {
      // Every allocation is fully credited; pick the partner's allocation on the drawn batch.
      const { data: onBatch } = await supabase
        .from("batch_allocations")
        .select("id, batch_id")
        .eq("partner_id", partnerId)
        .in("channel", ["contract_brewing", "distribution", "wholesale"])
        .in("batch_id", perBatchDrawBbl.map((d) => d.batchId))
        .limit(1);
      const row = (onBatch ?? [])[0] as { id: string; batch_id: string } | undefined;
      if (row) { targetAllocationId = row.id; batchId = row.batch_id; }
    }
    if (batchId) {
      over = { bbl: overBbl, targetAllocationId, homes: await listHomes(supabase, { batchId, targetAllocationId }) };
    }
  }

  return { plan, candidates, batches, perBatchDrawBbl, requestedBbl, lines: lineAvailability, overBbl, noCommitment, over };
}
