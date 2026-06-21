import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { checkAndFulfillCommitment } from "@/lib/production/commitmentFulfillment";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body: ShipRequest = await req.json();
  const { partner_id, recipe_id, packaging_item_id, variant_label, quantity, notes } = body;

  if (!partner_id || !recipe_id || !packaging_item_id || !variant_label || !quantity || quantity <= 0) {
    return NextResponse.json({ error: "partner_id, recipe_id, packaging_item_id, variant_label, and a positive quantity are required" }, { status: 400 });
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
  const requestedBbl = (quantity * volumeFlOz) / BBL_TO_FL_OZ;

  // ── 2. Validate availability ──────────────────────────────────────────────
  const { data: invRows, error: invErr } = await supabase
    .from("cold_storage_inventory")
    .select("id, batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipe_id)
    .eq("packaging_item_id", packaging_item_id)
    .eq("variant_label", variant_label)
    .order("created_at", { ascending: true });
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });

  const totalAvailable = (invRows ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
  if (quantity > totalAvailable) {
    return NextResponse.json(
      { error: `Insufficient cold storage inventory for "${variant_label}" — requested ${quantity}, available ${totalAvailable}` },
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
  type Credit = { allocationId: string; batchId: string; channel: string; creditedBbl: number };
  const credits: Credit[] = [];
  let bblLeft = requestedBbl;
  for (let i = 0; i < candidates.length && bblLeft > 0.0001; i++) {
    const c = candidates[i];
    const isLast = i === candidates.length - 1 || bblLeft <= c.remainingBbl;
    const creditedBbl = isLast ? bblLeft : Math.min(c.remainingBbl, bblLeft);
    credits.push({ allocationId: c.allocationId, batchId: c.batchId, channel: c.channel, creditedBbl });
    bblLeft -= creditedBbl;
  }

  // ── 5. Deplete cold_storage_inventory, oldest row first ───────────────────
  let qtyLeft = quantity;
  for (const row of invRows ?? []) {
    if (qtyLeft <= 0) break;
    const take = Math.min(Number(row.quantity_on_hand), qtyLeft);
    const newQty = Number(row.quantity_on_hand) - take;
    if (newQty <= 0.0001) {
      await supabase.from("cold_storage_inventory").delete().eq("id", row.id);
    } else {
      await supabase.from("cold_storage_inventory").update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    qtyLeft -= take;
  }

  // ── 6. Look up the export_bay equipment row ───────────────────────────────
  const { data: exportBayTank } = await supabase.from("equipment").select("id").eq("type", "export_bay").limit(1).single();
  const exportBayId = exportBayTank?.id ?? null;

  // ── 7. Write batch_transfers (one per batch) + export_transactions (one per credited allocation) ──
  const shipmentId = crypto.randomUUID();
  const byBatch = new Map<string, Credit[]>();
  for (const c of credits) {
    if (!byBatch.has(c.batchId)) byBatch.set(c.batchId, []);
    byBatch.get(c.batchId)!.push(c);
  }

  const created: { batch_id: string; export_transaction_ids: string[] }[] = [];

  for (const [batchId, batchCredits] of byBatch) {
    const batchTotalBbl = batchCredits.reduce((s, c) => s + c.creditedBbl, 0);

    const { data: transfer, error: trErr } = await supabase
      .from("batch_transfers")
      .insert({
        batch_id: batchId,
        from_tank_id: null,
        to_tank_id: exportBayId,
        volume_bbl: Math.round(batchTotalBbl * 10000) / 10000,
        shrinkage_bbl: 0,
        transfer_type: "export",
        notes: notes ?? null,
      })
      .select("id")
      .single();
    if (trErr) return NextResponse.json({ error: trErr.message }, { status: 500 });

    const exportTransactionIds: string[] = [];
    for (const c of batchCredits) {
      const creditedQty = Math.round((c.creditedBbl / requestedBbl) * quantity * 10000) / 10000;
      const taxBreakdown = await computeExciseTaxBreakdown(supabase, c.creditedBbl);
      const totalExciseTaxUsd = Math.round(taxBreakdown.reduce((s, t) => s + t.amountUsd, 0) * 100) / 100;

      const { data: exportTx, error: exTxErr } = await supabase
        .from("export_transactions")
        .insert({
          shipment_id: shipmentId,
          batch_id: batchId,
          recipe_id,
          allocation_id: c.allocationId,
          packaging_item_id,
          variant_label,
          quantity: creditedQty,
          volume_bbl: Math.round(c.creditedBbl * 10000) / 10000,
          channel: c.channel,
          recipient_id: partner_id,
          recipient_name: null,
          total_excise_tax_usd: totalExciseTaxUsd,
          source_transfer_id: transfer.id,
          notes: notes ?? null,
        })
        .select("id")
        .single();
      if (exTxErr) return NextResponse.json({ error: exTxErr.message }, { status: 500 });

      if (taxBreakdown.length > 0) {
        const { error: taxErr } = await supabase.from("export_transaction_taxes").insert(
          taxBreakdown.map((t) => ({
            export_transaction_id: exportTx.id,
            excise_tax_rate_id: t.rateId,
            tax_name: t.name,
            unit: t.unit,
            rate_usd: t.rateUsd,
            amount_usd: t.amountUsd,
          }))
        );
        if (taxErr) return NextResponse.json({ error: taxErr.message }, { status: 500 });
      }

      exportTransactionIds.push(exportTx.id);
    }

    await checkAndCompleteBatch(supabase, batchId);
    for (const c of batchCredits) {
      await checkAndFulfillCommitment(supabase, c.allocationId);
    }

    created.push({ batch_id: batchId, export_transaction_ids: exportTransactionIds });
  }

  return NextResponse.json({ created }, { status: 201 });
}
