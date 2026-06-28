// app/api/production/export-bay/ship-adhoc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { getUnitsPerPackage } from "@/lib/production/packagingVariations";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

interface AdHocShipRequest {
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  partner_id?: string | null;
  recipient_name?: string | null;
  recipe_id: string;
  variation_id: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: AdHocShipRequest = await req.json();
  const { channel, partner_id, recipient_name, recipe_id, variation_id, quantity, notes } = body;

  if (!channel || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json(
      { error: "channel, recipe_id, variation_id, and a positive quantity are required" },
      { status: 400 }
    );
  }
  if (channel !== "taproom" && !partner_id) {
    return NextResponse.json({ error: "partner_id is required unless channel is taproom" }, { status: 400 });
  }

  // ── 1. Resolve variation → volume + display name + container item id ─────
  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name, format, tray_id, paktech_id")
    .eq("id", variation_id)
    .single();
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  if (!variation) return NextResponse.json({ error: "Variation not found." }, { status: 404 });
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

  // ── 3. Deplete cold_storage_inventory, oldest row first ───────────────────
  let depleted: { batchId: string; depletedQty: number }[];
  try {
    depleted = await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 4. Write one export_transaction per depleted batch row ────────────────
  const shipmentId = crypto.randomUUID();
  const created: { batch_id: string; export_transaction_id: string }[] = [];

  for (const { batchId, depletedQty } of depleted) {
    const volumeBbl = (depletedQty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;

    let exportTxId: string;
    try {
      exportTxId = await writeExportTransaction(supabase, {
        shipmentId,
        batchId,
        recipeId: recipe_id,
        packagingItemId: variation.container_id,
        variantLabel: variation.name,
        quantity: depletedQty,
        volumeBbl,
        channel,
        recipientId: partner_id ?? null,
        recipientName: recipient_name ?? null,
        allocationId: null,
        notes,
        packagingFormat: variation.format,
        unitsPerPackage,
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    await checkAndCompleteBatch(supabase, batchId);

    created.push({ batch_id: batchId, export_transaction_id: exportTxId });
  }

  return NextResponse.json({ created }, { status: 201 });
}
