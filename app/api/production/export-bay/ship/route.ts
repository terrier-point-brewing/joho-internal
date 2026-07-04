import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import {
  planShipment,
  type AllocationChannel,
  type AllocationInput,
  type BatchInput,
  type ShipmentCandidate,
} from "@/lib/production/allocationReserve";

export const dynamic = "force-dynamic";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const round4 = (n: number) => Math.round(n * 10000) / 10000;

interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  variation_id: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: ShipRequest = await req.json();
  const { partner_id, recipe_id, variation_id, quantity, notes } = body;

  if (!partner_id || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json({ error: "partner_id, recipe_id, variation_id, and a positive quantity are required" }, { status: 400 });
  }

  // ── 1. Resolve variation → volume + display name + container item id ─────
  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name, format, tray_id, paktech_id")
    .eq("id", variation_id)
    .single();
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  if (!variation) return NextResponse.json({ error: "Variation not found." }, { status: 404 });
  const requestedBbl = (quantity * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
  const unitsPerPackage = await getUnitsPerPackage(supabase, {
    format: variation.format,
    tray_id: variation.tray_id,
    paktech_id: variation.paktech_id,
  });

  // ── 2. Validate availability ──────────────────────────────────────────────
  let totalAvailable: number;
  try {
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variation.name}" — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }

  // ── 3. This partner's allocations for the recipe (crediting candidates) ───
  const { data: allocRows, error: allocErr } = await supabase
    .from("batch_allocations")
    .select(`
      id, batch_id, channel, partner_id, percentage, contract_request_id,
      commitments(volume_bbl),
      brew_batches!inner(id, recipe_id, created_at, status)
    `)
    .eq("partner_id", partner_id)
    .neq("channel", "taproom")
    .eq("brew_batches.recipe_id", recipe_id);
  if (allocErr) return NextResponse.json({ error: allocErr.message }, { status: 500 });

  // ── 4. Deplete cold storage (physical, oldest-first) → per-batch draw ─────
  let depleted: { batchId: string; depletedQty: number }[];
  try {
    depleted = await depleteColdStorageInventory(supabase, { recipeId: recipe_id, variationId: variation_id, quantity });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  const bblPerUnit = variation.total_volume_fl_oz / BBL_TO_FL_OZ;
  const perBatchDrawBbl = depleted.map((d) => ({ batchId: d.batchId, drawBbl: d.depletedQty * bblPerUnit }));

  // ── 5. Reserve state for every batch this shipment credits or draws from ──
  const reserveBatchIds = [...new Set([
    ...(allocRows ?? []).map((a) => a.batch_id),
    ...depleted.map((d) => d.batchId),
  ])];
  const inList = reserveBatchIds.length ? reserveBatchIds : [ZERO_UUID];

  // Every non-taproom allocation on those batches — other partners' contract
  // claims count toward the guarantee reserve, not just this partner's.
  const { data: reserveAllocRows } = await supabase
    .from("batch_allocations")
    .select("id, batch_id, channel, partner_id, percentage, contract_request_id, commitments(volume_bbl)")
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

  // exports: total per batch (on-hand) + per batch:channel:recipient (allocation exported)
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

  type ReserveAllocRow = { id: string; batch_id: string; channel: string; partner_id: string | null; percentage: number; commitments: { volume_bbl: number } | null };
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

  // ── 6. Crediting candidates: contract first (up to booked), then soft, oldest first ─
  type CandRow = { id: string; batch_id: string; channel: string; percentage: number; commitments: { volume_bbl: number } | null; brew_batches: { created_at: string } };
  const candidates: ShipmentCandidate[] = ((allocRows ?? []) as unknown as CandRow[])
    .map((a) => {
      const channel = a.channel as AllocationChannel;
      const exported = exportedByKey[`${a.batch_id}:${a.channel}:${partner_id}`] ?? 0;
      const booked = channel === "contract_brewing" ? (a.commitments?.volume_bbl ?? 0) : null;
      const bookedRemainingBbl = channel === "contract_brewing" ? Math.max(0, (booked ?? 0) - exported) : null;
      return { allocationId: a.id, batchId: a.batch_id, channel, bookedRemainingBbl, _createdAt: a.brew_batches.created_at };
    })
    // Drop fully-shipped contract allocations; keep all soft (uncapped absorbers).
    .filter((c) => (c.channel === "contract_brewing" ? (c.bookedRemainingBbl ?? 0) > 0.0001 : true))
    .sort((x, y) => {
      const cx = x.channel === "contract_brewing" ? 0 : 1;
      const cy = y.channel === "contract_brewing" ? 0 : 1;
      if (cx !== cy) return cx - cy;
      return new Date(x._createdAt).getTime() - new Date(y._createdAt).getTime();
    })
    .map(({ allocationId, batchId, channel, bookedRemainingBbl }) => ({ allocationId, batchId, channel, bookedRemainingBbl }));

  // ── 7. Plan credits + advisory warnings ──────────────────────────────────
  const plan = planShipment({ requestedBbl, candidates, perBatchDrawBbl, batches });

  // ── 8. Expand credits into export writes. Over-delivery (allocation_id null)
  //       is attributed to the physically drawn batches; quantity is split
  //       proportional to volume with the last write taking the remainder. ───
  const candById = new Map(candidates.map((c) => [c.allocationId, c]));
  const overDeliveryChannel: string =
    candidates.find((c) => c.channel === "contract_brewing")?.channel
    ?? candidates[0]?.channel
    ?? "distribution";
  const totalDrawQty = depleted.reduce((s, d) => s + d.depletedQty, 0);

  type Write = { batchId: string; allocationId: string | null; channel: string; bbl: number; overAllocation: boolean; qty: number };
  const writes: Write[] = [];
  for (const cr of plan.credits) {
    if (cr.allocationId) {
      const cand = candById.get(cr.allocationId)!;
      writes.push({ batchId: cand.batchId, allocationId: cr.allocationId, channel: cand.channel, bbl: cr.bbl, overAllocation: false, qty: 0 });
    } else if (totalDrawQty > 0) {
      for (const d of depleted) {
        const portion = cr.bbl * (d.depletedQty / totalDrawQty);
        if (portion <= 0.0001) continue;
        writes.push({ batchId: d.batchId, allocationId: null, channel: overDeliveryChannel, bbl: round4(portion), overAllocation: cr.overAllocation, qty: 0 });
      }
    }
  }

  const totalWriteBbl = writes.reduce((s, w) => s + w.bbl, 0) || 1;
  let qtyAssigned = 0;
  writes.forEach((w, i) => {
    w.qty = i === writes.length - 1 ? round4(quantity - qtyAssigned) : round4((w.bbl / totalWriteBbl) * quantity);
    qtyAssigned += w.qty;
  });

  // ── 9. Write export_transactions ─────────────────────────────────────────
  const shipmentId = crypto.randomUUID();
  const created: { batch_id: string; export_transaction_id: string }[] = [];
  const completedBatches = new Set<string>();

  for (const w of writes) {
    let exportTxId: string;
    try {
      exportTxId = await writeExportTransaction(supabase, {
        shipmentId,
        batchId: w.batchId,
        recipeId: recipe_id,
        packagingItemId: variation.container_id,
        variantLabel: variation.name,
        quantity: w.qty,
        volumeBbl: w.bbl,
        channel: w.channel,
        recipientId: partner_id,
        recipientName: null,
        allocationId: w.allocationId,
        notes,
        packagingFormat: variation.format,
        unitsPerPackage,
        overAllocation: w.overAllocation,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    if (!completedBatches.has(w.batchId)) {
      await checkAndCompleteBatch(supabase, w.batchId);
      completedBatches.add(w.batchId);
    }
    if (w.allocationId) await checkAndFulfillCommitment(supabase, w.allocationId);

    created.push({ batch_id: w.batchId, export_transaction_id: exportTxId });
  }

  return NextResponse.json({ created, warnings: plan.warnings }, { status: 201 });
}
