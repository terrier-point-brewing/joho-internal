import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { planShipment } from "@/lib/production/allocationReserve";
import { loadShipReserveContext } from "@/lib/production/shipReserveContext";

export const dynamic = "force-dynamic";

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

  // ── 3. Deplete cold storage (physical, oldest-first) → per-batch draw ─────
  let depleted: { batchId: string; depletedQty: number }[];
  try {
    depleted = await depleteColdStorageInventory(supabase, { recipeId: recipe_id, variationId: variation_id, quantity });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  const bblPerUnit = variation.total_volume_fl_oz / BBL_TO_FL_OZ;
  const perBatchDrawBbl = depleted.map((d) => ({ batchId: d.batchId, drawBbl: d.depletedQty * bblPerUnit }));

  // ── 4. Reserve state + crediting candidates (shared with the preview route) ─
  const { candidates, batches } = await loadShipReserveContext(supabase, {
    recipeId: recipe_id,
    partnerId: partner_id,
    drawnBatchIds: depleted.map((d) => d.batchId),
  });

  // ── 5. Plan credits + advisory warnings ──────────────────────────────────
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
