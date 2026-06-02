import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { EQUIPMENT_TYPE_TO_STATUS, UNCONSTRAINED_EQUIPMENT_TYPES, EquipmentType } from "@/app/production/types";

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

  const { data: transfer, error } = await supabase
    .from("batch_transfers")
    .insert({
      batch_id,
      from_tank_id:  from_tank_id  || null,
      to_tank_id:    to_tank_id    || null,
      volume_bbl,
      shrinkage_bbl: shrinkage_bbl ?? 0,
      transfer_type: transfer_type ?? "transfer",
      notes:         notes         || null,
      kegging_detail:  kegging_detail  ?? null,
      canning_detail:  canning_detail  ?? null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Release existing tank assignment for this batch
  const { data: oldAssignment } = await supabase
    .from("batch_tank_assignments")
    .select("id")
    .eq("batch_id", batch_id)
    .is("released_at", null)
    .maybeSingle();

  if (oldAssignment) {
    await supabase
      .from("batch_tank_assignments")
      .update({ released_at: new Date().toISOString() })
      .eq("id", oldAssignment.id);
  }

  // Determine new batch status from destination tank type
  let newStatus: string | null = null;
  if (to_tank_id) {
    const { data: destTank } = await supabase
      .from("equipment").select("type").eq("id", to_tank_id).single();

    if (destTank) {
      newStatus = EQUIPMENT_TYPE_TO_STATUS[destTank.type as EquipmentType] ?? null;

      // Create new assignment only for capacity-constrained tanks
      if (!UNCONSTRAINED_EQUIPMENT_TYPES.includes(destTank.type as EquipmentType)) {
        await supabase.from("batch_tank_assignments")
          .insert({ batch_id, tank_id: to_tank_id, notes: null });
      }
    }
  }

  // Update batch status if it changed
  if (newStatus) {
    const { data: batch } = await supabase
      .from("brew_batches").select("status").eq("id", batch_id).single();

    if (batch?.status !== newStatus) {
      await supabase.from("brew_batches").update({ status: newStatus }).eq("id", batch_id);
      await supabase.from("batch_status_history").insert({
        batch_id,
        status: newStatus,
        note: `Auto: transferred to ${transfer_type}`,
      });
    }
  }

  return NextResponse.json(transfer, { status: 201 });
}
