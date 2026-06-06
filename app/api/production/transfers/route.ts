import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const batch_id = searchParams.get("batch_id");

  let query = supabase
    .from("batch_transfers")
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type)")
    .order("transferred_at", { ascending: false });

  if (batch_id) query = query.eq("batch_id", batch_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    volume_bbl,
    shrinkage_bbl,
    transfer_type,
    notes,
    kegging_detail,
    canning_detail,
  } = body;

  // Capacity guard: reject before hitting the RPC if destination is a
  // constrained tank and the transfer volume exceeds its capacity_bbl.
  if (to_tank_id && volume_bbl != null) {
    const { data: destTank } = await supabase
      .from("equipment")
      .select("capacity_bbl, type")
      .eq("id", to_tank_id)
      .single();
    const UNCONSTRAINED = new Set(["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"]);
    if (destTank && !UNCONSTRAINED.has(destTank.type) && destTank.capacity_bbl != null) {
      if (volume_bbl > destTank.capacity_bbl) {
        return NextResponse.json(
          { error: `Transfer volume (${volume_bbl} BBL) exceeds destination capacity (${destTank.capacity_bbl} BBL).` },
          { status: 422 }
        );
      }
    }
  }

  // One transaction: insert transfer, release the old assignment, create the
  // new assignment (constrained destinations only), and roll batch status
  // forward. See record_batch_transfer() — keeps these writes atomic.
  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:       batch_id,
      p_from_tank_id:   from_tank_id  || null,
      p_to_tank_id:     to_tank_id    || null,
      p_volume_bbl:     volume_bbl,
      p_shrinkage_bbl:  shrinkage_bbl ?? 0,
      p_transfer_type:  transfer_type ?? "transfer",
      p_notes:          notes         || null,
      p_kegging_detail: kegging_detail ?? null,
      p_canning_detail: canning_detail ?? null,
    })
    .single();

  if (error) {
    // "Destination tank is already occupied" is a client conflict, not a 500.
    const status = error.message.includes("already occupied") ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // ── Packaging deduction ───────────────────────────────────────────────────
  // When kegging or canning product arrives in cold storage, consume the
  // packaging items used so inventory stays accurate.
  if (transfer_type === "kegging" && kegging_detail?.kegs?.length) {
    for (const keg of kegging_detail.kegs as { packaging_id?: string; quantity: number }[]) {
      if (!keg.packaging_id || !keg.quantity) continue;
      const { data: pkg } = await supabase
        .from("packaging_items")
        .select("stock_quantity")
        .eq("id", keg.packaging_id)
        .single();
      if (pkg) {
        const newQty = Number(pkg.stock_quantity) - keg.quantity;
        await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", keg.packaging_id);
        await supabase.from("packaging_stock_adjustments").insert({
          packaging_item_id:  keg.packaging_id,
          quantity:           -keg.quantity,
          type:               "used",
          note:               `Kegging — batch ${batch_id}`,
          batch_transfer_id:  (transfer as { id: string }).id,
          cost_per_unit:      null,
          total_value_change: null,
        });
      }
    }
  }

  if (transfer_type === "canning" && canning_detail) {
    const cd = canning_detail as {
      can_packaging_id?: string;
      lid_packaging_id?: string;
      paktech_packaging_id?: string;
      tray_packaging_id?: string;
      label_packaging_id?: string;
      total_cans?: number;
      cases?: number;
      cans_per_case?: number;
    };
    const totalCans = cd.total_cans ?? 0;
    const cases     = cd.cases ?? 0;

    const deductions: { id: string | undefined; qty: number; label: string }[] = [
      { id: cd.can_packaging_id,     qty: totalCans, label: "cans" },
      { id: cd.lid_packaging_id,     qty: totalCans, label: "lids" },
      { id: cd.label_packaging_id,   qty: totalCans, label: "labels" },
      { id: cd.tray_packaging_id,    qty: cases,     label: "trays" },
    ];

    if (cd.paktech_packaging_id) {
      const { data: ptItem } = await supabase
        .from("packaging_items")
        .select("can_count")
        .eq("id", cd.paktech_packaging_id)
        .single();
      const paktechCount = Math.ceil(totalCans / Math.max(1, ptItem?.can_count ?? 4));
      deductions.push({ id: cd.paktech_packaging_id, qty: paktechCount, label: "paktechs" });
    }

    for (const d of deductions) {
      if (!d.id || !d.qty) continue;
      const { data: pkg } = await supabase
        .from("packaging_items")
        .select("stock_quantity")
        .eq("id", d.id)
        .single();
      if (pkg) {
        const newQty = Number(pkg.stock_quantity) - d.qty;
        await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
        await supabase.from("packaging_stock_adjustments").insert({
          packaging_item_id:  d.id,
          quantity:           -d.qty,
          type:               "used",
          note:               `Canning (${d.label}) — batch ${batch_id}`,
          batch_transfer_id:  (transfer as { id: string }).id,
          cost_per_unit:      null,
          total_value_change: null,
        });
      }
    }
  }

  // brew_batches.volume_bbl is the ORIGINAL brew volume and must not be mutated
  // by transfers — the transfer ledger (batch_transfers) is the source of truth
  // for current per-tank volumes.

  // Partial-transfer: the RPC always releases the from_tank assignment, but if
  // volume remains in the source tank we need to re-insert the assignment so the
  // floorplan tile keeps showing the batch there.
  //
  // Compute remaining volume from the ledger rather than brew_batches.volume_bbl
  // so that chains of prior partial draws are accounted for correctly.
  if (from_tank_id) {
    const { data: ledgerRows } = await supabase
      .from("batch_transfers")
      .select("from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl")
      .eq("batch_id", batch_id)
      .or(`from_tank_id.eq.${from_tank_id},to_tank_id.eq.${from_tank_id}`);

    const netInTank = (ledgerRows ?? []).reduce((sum, row) => {
      if (row.to_tank_id   === from_tank_id) return sum + Number(row.volume_bbl);
      if (row.from_tank_id === from_tank_id) return sum - Number(row.volume_bbl) - Number(row.shrinkage_bbl ?? 0);
      return sum;
    }, 0);

    if (netInTank > 0.001) {
      await supabase
        .from("batch_tank_assignments")
        .insert({ batch_id, tank_id: from_tank_id });
    }
  }

  return NextResponse.json(transfer, { status: 201 });
}
