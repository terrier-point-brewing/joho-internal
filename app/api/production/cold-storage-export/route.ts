import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export interface ExportLineItem {
  /** The keg/can label from kegging_detail/canning_detail, e.g. "1/6 BBL" or "can" */
  product_label: string;
  /** "keg" | "can" */
  product_type: "keg" | "can";
  quantity: number;
}

export interface ColdStorageExportRequest {
  cold_storage_tank_id: string;
  items: ExportLineItem[];
  channel: "taproom" | "distribution" | "contract_brewing";
  /** For contract_brewing */
  partner_id?: string | null;
  partner_name?: string | null;
  recipient_name?: string | null;
  notes?: string | null;
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body: ColdStorageExportRequest = await req.json();
  const { cold_storage_tank_id, items, channel, partner_id, partner_name, recipient_name, notes } = body;

  if (!cold_storage_tank_id || !items?.length || !channel) {
    return NextResponse.json({ error: "cold_storage_tank_id, items, and channel are required" }, { status: 400 });
  }

  // ── 1. Fetch all inbound cold-storage transfers (kegging / canning) ──────────
  const { data: inboundRaw, error: inErr } = await supabase
    .from("batch_transfers")
    .select("id, batch_id, transfer_type, kegging_detail, canning_detail, transferred_at")
    .eq("to_tank_id", cold_storage_tank_id)
    .in("transfer_type", ["kegging", "canning"])
    .order("transferred_at", { ascending: true }); // oldest first for FIFO

  if (inErr) return NextResponse.json({ error: inErr.message }, { status: 500 });
  if (!inboundRaw?.length) return NextResponse.json({ error: "Cold storage is empty" }, { status: 400 });

  // ── 2. Fetch all prior export transfers from this cold-storage tank ──────────
  const { data: priorExports, error: exErr } = await supabase
    .from("batch_transfers")
    .select("batch_id, export_detail")
    .eq("from_tank_id", cold_storage_tank_id)
    .eq("transfer_type", "export");

  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });

  // ── 3a. Fetch can volume for BBL conversion ──────────────────────────────────
  const { data: canItems, error: canItemsErr } = await supabase
    .from("packaging_items")
    .select("volume_fl_oz, is_default")
    .eq("type", "can")
    .order("is_default", { ascending: false });
  if (canItemsErr) return NextResponse.json({ error: canItemsErr.message }, { status: 500 });

  // Use default can volume, fall back to first available
  const canVolumeFlOz: number | null =
    (canItems?.find((c) => c.is_default) ?? canItems?.[0])?.volume_fl_oz ?? null;

  const BBL_FL_OZ = 3968; // 1 BBL = 31 gal × 128 fl oz
  const BBL_TO_GAL = 31;
  const FEDERAL_EXCISE_PER_BBL = 3.50;   // USD per BBL (craft < 60k BBL/yr)
  const NC_EXCISE_PER_GAL      = 0.62;   // USD per gallon (NC beer tax)

  /** Parse keg name like "1/6 BBL" → volume in BBL, or null if unrecognized. */
  function kegNameToBbl(name: string): number | null {
    const m = name.match(/^(\d+)\/(\d+)\s*bbl$/i);
    if (m) return parseInt(m[1]) / parseInt(m[2]);
    return null;
  }

  // ── 3b. Compute remaining inventory per (batch_id, transfer_id, product_label) ─
  type InvEntry = {
    batchTransferId: string;
    batchId: string;
    productLabel: string;
    productType: "keg" | "can";
    totalQty: number;
    exportedQty: number;
    transferredAt: string;
    volumeFlOz: number | null; // per unit
  };

  const inventory: InvEntry[] = [];

  for (const tr of inboundRaw) {
    if (tr.transfer_type === "kegging" && tr.kegging_detail) {
      const kd = tr.kegging_detail;
      if (kd.quantity > 0) {
        const flOz = kd.volume_fl_oz ?? (kegNameToBbl(kd.name) != null ? kegNameToBbl(kd.name)! * BBL_FL_OZ : null);
        inventory.push({
          batchTransferId: tr.id,
          batchId: tr.batch_id,
          productLabel: kd.name,
          productType: "keg",
          totalQty: kd.quantity,
          exportedQty: 0,
          transferredAt: tr.transferred_at,
          volumeFlOz: flOz,
        });
      }
    } else if (tr.transfer_type === "canning" && tr.canning_detail) {
      const cd = tr.canning_detail;
      const cansPerUnit = cd.format === "case" ? cd.cans_per_case : cd.format === "pack" ? cd.cans_per_pack : 1;
      const totalCans = cd.quantity * cansPerUnit;
      if (totalCans > 0) {
        inventory.push({
          batchTransferId: tr.id,
          batchId: tr.batch_id,
          productLabel: "can",
          productType: "can",
          totalQty: totalCans,
          exportedQty: 0,
          transferredAt: tr.transferred_at,
          volumeFlOz: canVolumeFlOz,
        });
      }
    }
  }

  // Subtract prior exports
  for (const ex of priorExports ?? []) {
    const detail = ex.export_detail as {
      items?: { source_transfer_id: string; product_label: string; quantity: number }[];
    } | null;
    if (!detail?.items) continue;
    for (const ei of detail.items) {
      const inv = inventory.find(
        (e) => e.batchTransferId === ei.source_transfer_id && e.productLabel === ei.product_label
      );
      if (inv) inv.exportedQty += ei.quantity;
    }
  }

  // ── 4. FIFO allocation ───────────────────────────────────────────────────────
  // For each requested item, allocate from oldest batch first.
  type Allocation = {
    batchId: string;
    batchTransferId: string;
    productLabel: string;
    productType: "keg" | "can";
    quantity: number;
    volumeFlOz: number | null;
  };

  const allocations: Allocation[] = [];

  for (const item of items) {
    let remaining = item.quantity;
    // inventory is already sorted oldest-first (from the DB query)
    const candidates = inventory.filter(
      (e) => e.productLabel === item.product_label && e.productType === item.product_type && e.totalQty - e.exportedQty > 0
    );

    for (const inv of candidates) {
      if (remaining <= 0) break;
      const available = inv.totalQty - inv.exportedQty;
      const take = Math.min(available, remaining);
      allocations.push({
        batchId: inv.batchId,
        batchTransferId: inv.batchTransferId,
        productLabel: inv.productLabel,
        productType: inv.productType,
        quantity: take,
        volumeFlOz: inv.volumeFlOz,
      });
      inv.exportedQty += take;
      remaining -= take;
    }

    if (remaining > 0) {
      return NextResponse.json(
        { error: `Insufficient cold storage inventory for "${item.product_label}" — requested ${item.quantity}, available ${item.quantity - remaining}` },
        { status: 422 }
      );
    }
  }

  // ── 5. Look up the export_bay tank to use as destination ────────────────────
  const { data: exportBayTank, error: exportBayErr } = await supabase
    .from("equipment")
    .select("id")
    .eq("type", "export_bay")
    .limit(1)
    .single();
  if (exportBayErr && exportBayErr.code !== "PGRST116") return NextResponse.json({ error: exportBayErr.message }, { status: 500 });

  const exportBayId = exportBayTank?.id ?? null;

  // ── 6. Group allocations by batch_id and create one transfer + one export record each ─
  const byBatch = new Map<string, Allocation[]>();
  for (const a of allocations) {
    if (!byBatch.has(a.batchId)) byBatch.set(a.batchId, []);
    byBatch.get(a.batchId)!.push(a);
  }

  const created = [];
  for (const [batchId, allocs] of byBatch) {
    // export_detail stores only the FIFO source ledger — which inbound transfers
    // contributed to this export. Destination/channel lives in batch_exports.
    const exportDetail = {
      items: allocs.map((a) => ({
        source_transfer_id: a.batchTransferId,
        product_label: a.productLabel,
        product_type: a.productType,
        quantity: a.quantity,
      })),
    };

    // Compute total volume in BBL for this batch's allocations
    const totalVolumeBbl = allocs.reduce((s, a) => {
      if (a.volumeFlOz == null) return s;
      return s + Math.round((a.quantity * a.volumeFlOz / BBL_FL_OZ) * 10000) / 10000;
    }, 0);

    // batch_transfers — physical movement from cold storage → export bay
    const { data: transfer, error: trErr } = await supabase
      .from("batch_transfers")
      .insert({
        batch_id: batchId,
        from_tank_id: cold_storage_tank_id,
        to_tank_id: exportBayId,
        volume_bbl: Math.round(totalVolumeBbl * 10000) / 10000,
        shrinkage_bbl: 0,
        transfer_type: "export",
        notes: notes ?? null,
        export_detail: exportDetail,
      })
      .select("id, batch_id, transferred_at")
      .single();

    if (trErr) return NextResponse.json({ error: trErr.message }, { status: 500 });

    // batch_exports — one row per product type per batch so the Export tab shows it
    for (const alloc of allocs) {
      const volumeBbl = alloc.volumeFlOz != null
        ? Math.round((alloc.quantity * alloc.volumeFlOz / BBL_FL_OZ) * 10000) / 10000
        : null;

      const federalExcise = volumeBbl != null
        ? Math.round(volumeBbl * FEDERAL_EXCISE_PER_BBL * 100) / 100
        : null;
      const stateExcise = volumeBbl != null
        ? Math.round(volumeBbl * BBL_TO_GAL * NC_EXCISE_PER_GAL * 100) / 100
        : null;

      const { error: exErr } = await supabase.from("batch_exports").insert({
        batch_id: batchId,
        transfer_id: transfer.id,
        channel,
        recipient_id: channel === "contract_brewing" ? (partner_id ?? null) : null,
        recipient_name: channel === "contract_brewing"
          ? (partner_name ?? null)
          : (recipient_name ?? null),
        product_type: alloc.productType,
        quantity: alloc.quantity,
        unit: alloc.productLabel,
        volume_bbl: volumeBbl,
        federal_excise_tax_usd: federalExcise,
        state_excise_tax_usd:   stateExcise,
        notes: notes ?? null,
      });
      if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
    }

    created.push(transfer);
  }

  return NextResponse.json({ created }, { status: 201 });
}
