import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { getExportBayEquipmentId } from "@/lib/production/exportBayEquipment";
import { getAvailableColdStorageQuantity, depleteColdStorageInventory } from "@/lib/production/coldStorageDepletion";
import { writeExportTransfer, writeExportTransaction } from "@/lib/production/exportTransactionWriter";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

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
    .select("total_volume_fl_oz, container_id, name")
    .eq("id", variation_id)
    .single();
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  if (!variation) return NextResponse.json({ error: "Variation not found." }, { status: 404 });
  const requestedBbl = (quantity * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;

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

  // ── 3. Fetch this customer's eligible allocations for this recipe ────────
  const { data: allocRows, error: allocErr } = await supabase
    .from("batch_allocations")
    .select(`
      id, batch_id, channel, partner_id, percentage, contract_request_id,
      brew_batches!inner(id, recipe_id, created_at)
    `)
    .eq("partner_id", partner_id)
    .neq("channel", "taproom")
    .eq("brew_batches.recipe_id", recipe_id);
  if (allocErr) return NextResponse.json({ error: allocErr.message }, { status: 500 });

  const batchIds = [...new Set((allocRows ?? []).map((a) => a.batch_id))];
  const { data: prodTransfers } = await supabase
    .from("batch_transfers")
    .select("batch_id, volume_bbl, shrinkage_bbl")
    .in("batch_id", batchIds.length > 0 ? batchIds : ["00000000-0000-0000-0000-000000000000"])
    .in("transfer_type", ["kegging", "canning"]);
  const producedByBatch: Record<string, number> = {};
  for (const t of prodTransfers ?? []) {
    producedByBatch[t.batch_id] = (producedByBatch[t.batch_id] ?? 0) + (Number(t.volume_bbl) - Number(t.shrinkage_bbl ?? 0));
  }

  const { data: priorExports } = await supabase
    .from("export_transactions")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", batchIds.length > 0 ? batchIds : ["00000000-0000-0000-0000-000000000000"]);
  const exportedByKey: Record<string, number> = {};
  for (const e of priorExports ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedByKey[key] = (exportedByKey[key] ?? 0) + Number(e.volume_bbl);
  }

  type Candidate = { allocationId: string; batchId: string; channel: string; remainingBbl: number; batchCreatedAt: string };
  const candidates: Candidate[] = [];
  for (const a of allocRows ?? []) {
    const produced = producedByBatch[a.batch_id] ?? 0;
    if (produced <= 0) continue; // pending production — not a crediting candidate
    const allocatedBbl = (Number(a.percentage) / 100) * produced;
    const key = `${a.batch_id}:${a.channel}:${a.partner_id ?? ""}`;
    const exportedBbl = exportedByKey[key] ?? 0;
    const remaining = allocatedBbl - exportedBbl;
    if (remaining <= 0.0001) continue;
    const batchRow = a.brew_batches as unknown as { created_at: string };
    candidates.push({ allocationId: a.id, batchId: a.batch_id, channel: a.channel, remainingBbl: remaining, batchCreatedAt: batchRow.created_at });
  }
  candidates.sort((x, y) => new Date(x.batchCreatedAt).getTime() - new Date(y.batchCreatedAt).getTime());

  const totalRemaining = candidates.reduce((s, c) => s + c.remainingBbl, 0);
  if (requestedBbl > totalRemaining + 0.0001) {
    return NextResponse.json(
      { error: `Requested ${requestedBbl.toFixed(4)} BBL exceeds this customer's remaining allocation for this recipe (${totalRemaining.toFixed(4)} BBL).` },
      { status: 422 }
    );
  }

  // ── 4. Credit allocations sequentially, oldest batch first ───────────────
  type Credit = { allocationId: string; batchId: string; channel: string; creditedBbl: number; creditedQty: number };
  const credits: Credit[] = [];
  let bblLeft = requestedBbl;
  for (let i = 0; i < candidates.length && bblLeft > 0.0001; i++) {
    const c = candidates[i];
    const isLast = i === candidates.length - 1 || bblLeft <= c.remainingBbl;
    const creditedBbl = isLast ? bblLeft : Math.min(c.remainingBbl, bblLeft);
    credits.push({ allocationId: c.allocationId, batchId: c.batchId, channel: c.channel, creditedBbl, creditedQty: 0 });
    bblLeft -= creditedBbl;
  }

  // Compute each credit's unit quantity in one flat pass (NOT during the
  // later grouped-by-batch traversal, whose Map iteration order doesn't
  // match this array's order) so the sum always reconciles exactly to the
  // requested `quantity`, regardless of how many distinct batches are
  // credited or whether one batch contributes multiple, non-adjacent
  // entries to this array.
  let qtyAssigned = 0;
  for (let i = 0; i < credits.length; i++) {
    const isLastCredit = i === credits.length - 1;
    credits[i].creditedQty = isLastCredit
      ? Math.round((quantity - qtyAssigned) * 10000) / 10000
      : Math.round((credits[i].creditedBbl / requestedBbl) * quantity * 10000) / 10000;
    qtyAssigned += credits[i].creditedQty;
  }

  // ── 4b. Look up the export_bay equipment row (must happen before any write) ─
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

  // ── 5. Deplete cold_storage_inventory, oldest row first ───────────────────
  try {
    await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }

  // ── 6/7. Write batch_transfers (one per batch) + export_transactions (one per credited allocation) ──
  const shipmentId = crypto.randomUUID();
  const byBatch = new Map<string, Credit[]>();
  for (const c of credits) {
    if (!byBatch.has(c.batchId)) byBatch.set(c.batchId, []);
    byBatch.get(c.batchId)!.push(c);
  }

  const created: { batch_id: string; export_transaction_ids: string[] }[] = [];

  for (const [batchId, batchCredits] of byBatch) {
    const batchTotalBbl = batchCredits.reduce((s, c) => s + c.creditedBbl, 0);

    let transferId: string;
    try {
      transferId = await writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl: batchTotalBbl, notes });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }

    const exportTransactionIds: string[] = [];
    for (const c of batchCredits) {
      let exportTxId: string;
      try {
        exportTxId = await writeExportTransaction(supabase, {
          shipmentId,
          batchId,
          recipeId: recipe_id,
          packagingItemId: variation.container_id,
          variantLabel: variation.name,
          quantity: c.creditedQty,
          volumeBbl: c.creditedBbl,
          channel: c.channel,
          recipientId: partner_id,
          recipientName: null,
          allocationId: c.allocationId,
          sourceTransferId: transferId,
          notes,
        });
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
      }
      exportTransactionIds.push(exportTxId);
    }

    await checkAndCompleteBatch(supabase, batchId);
    for (const c of batchCredits) {
      await checkAndFulfillCommitment(supabase, c.allocationId);
    }

    created.push({ batch_id: batchId, export_transaction_ids: exportTransactionIds });
  }

  return NextResponse.json({ created }, { status: 201 });
}
