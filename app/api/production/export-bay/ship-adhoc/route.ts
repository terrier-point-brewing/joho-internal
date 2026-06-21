// app/api/production/export-bay/ship-adhoc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { getExportBayEquipmentId } from "@/lib/production/exportBayEquipment";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransfer, writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

interface AdHocShipRequest {
  channel: "taproom" | "distribution" | "contract_brewing";
  partner_id?: string | null;
  recipient_name?: string | null;
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: AdHocShipRequest = await req.json();
  const { channel, partner_id, recipient_name, recipe_id, packaging_item_id, variant_label, quantity, notes } = body;

  if (!channel || !recipe_id || !packaging_item_id || !variant_label || !quantity || quantity <= 0) {
    return NextResponse.json(
      { error: "channel, recipe_id, packaging_item_id, variant_label, and a positive quantity are required" },
      { status: 400 }
    );
  }
  if (channel !== "taproom" && !partner_id) {
    return NextResponse.json({ error: "partner_id is required unless channel is taproom" }, { status: 400 });
  }

  // ── 1. Volume conversion ──────────────────────────────────────────────────
  const { data: pkgItem, error: pkgErr } = await supabase
    .from("packaging_items")
    .select("volume_fl_oz")
    .eq("id", packaging_item_id)
    .single();
  if (pkgErr) return NextResponse.json({ error: pkgErr.message }, { status: 500 });
  const volumeFlOz = pkgItem?.volume_fl_oz ?? null;
  if (volumeFlOz == null) {
    return NextResponse.json({ error: "Selected packaging item has no volume configured — cannot compute BBL." }, { status: 422 });
  }

  // ── 2. Validate availability ──────────────────────────────────────────────
  let totalAvailable: number;
  try {
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variant_label}" — requested ${quantity}, available ${totalAvailable}` },
      { status: 422 }
    );
  }

  // ── 3. Look up the export_bay equipment row (must happen before any write) ─
  let exportBayId: string;
  try {
    const id = await getExportBayEquipmentId(supabase);
    if (!id) {
      return NextResponse.json(
        { error: "No 'export_bay' equipment configured — add one in Production → Brewing → Floorplan before shipping." },
        { status: 500 }
      );
    }
    exportBayId = id;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 4. Deplete cold_storage_inventory, oldest row first ───────────────────
  let depleted: { batchId: string; depletedQty: number }[];
  try {
    depleted = await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      packagingItemId: packaging_item_id,
      variantLabel: variant_label,
      quantity,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 5. Write one transfer + export transaction per depleted batch row ─────
  const shipmentId = crypto.randomUUID();
  const created: { batch_id: string; export_transaction_id: string }[] = [];

  for (const { batchId, depletedQty } of depleted) {
    const volumeBbl = (depletedQty * volumeFlOz) / BBL_TO_FL_OZ;

    let transferId: string;
    try {
      transferId = await writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl, notes });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    let exportTxId: string;
    try {
      exportTxId = await writeExportTransaction(supabase, {
        shipmentId,
        batchId,
        recipeId: recipe_id,
        packagingItemId: packaging_item_id,
        variantLabel: variant_label,
        quantity: depletedQty,
        volumeBbl,
        channel,
        recipientId: partner_id ?? null,
        recipientName: recipient_name ?? null,
        allocationId: null,
        sourceTransferId: transferId,
        notes,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    await checkAndCompleteBatch(supabase, batchId);

    created.push({ batch_id: batchId, export_transaction_id: exportTxId });
  }

  return NextResponse.json({ created }, { status: 201 });
}
