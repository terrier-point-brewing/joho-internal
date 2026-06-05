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

  // Update brew_batches.volume_bbl to reflect the transferred draw.
  // The RPC moves the assignment but doesn't resize the batch record; without
  // this a 40 BBL partial draw from an 80 BBL batch would still show 80 BBL
  // in the destination tank.  We set volume_bbl = drawBbl so the batch always
  // reflects the volume currently at its active location.
  if (volume_bbl != null) {
    await supabase
      .from("brew_batches")
      .update({ volume_bbl })
      .eq("id", batch_id);
  }

  return NextResponse.json(transfer, { status: 201 });
}
