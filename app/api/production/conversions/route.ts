import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/production/conversions
 *
 * Splits a partial volume from an existing batch into a new batch under a
 * different recipe.  Atomically:
 *   1. Creates the child brew_batch (converted_from_batch_id set to parent)
 *   2. Inserts a batch_transfers row (transfer_type = "conversion", to_batch_id set)
 *   3. Assigns the child batch to the destination fermenter
 *   4. Re-inserts the parent's tank assignment if volume remains
 */
export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const body = await req.json();
  const {
    batch_id,        // parent batch being split
    from_tank_id,    // tank the parent batch currently occupies
    to_tank_id,      // destination fermenter for the child batch
    volume_bbl,      // volume being converted (partial draw)
    recipe_id,       // recipe for the child batch
    beer_name,       // name for the child batch
    notes,
  } = body;

  if (!batch_id || !from_tank_id || !to_tank_id || !volume_bbl || !recipe_id || !beer_name) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Capacity guard
  const { data: destTank } = await supabase
    .from("equipment")
    .select("capacity_bbl, type, name")
    .eq("id", to_tank_id)
    .single();

  if (destTank?.capacity_bbl != null && volume_bbl > destTank.capacity_bbl) {
    return NextResponse.json(
      { error: `Volume (${volume_bbl} BBL) exceeds ${destTank.name} capacity (${destTank.capacity_bbl} BBL).` },
      { status: 422 }
    );
  }

  // Destination must be a fermenter
  if (destTank && destTank.type !== "fermenter") {
    return NextResponse.json({ error: "Conversion destination must be a fermenter." }, { status: 422 });
  }

  // Destination must not already hold a batch
  const { data: existingAssignment } = await supabase
    .from("batch_tank_assignments")
    .select("id")
    .eq("tank_id", to_tank_id)
    .is("released_at", null)
    .limit(1)
    .single();

  if (existingAssignment) {
    return NextResponse.json({ error: `${destTank?.name ?? "Destination tank"} is already occupied.` }, { status: 409 });
  }

  // Fetch parent batch and child recipe for date/volume/duration context
  const { data: parentBatch } = await supabase
    .from("brew_batches")
    .select("planned_brew_date, volume_bbl")
    .eq("id", batch_id)
    .single();

  const { data: childRecipe } = await supabase
    .from("recipes")
    .select("days_fermenter")
    .eq("id", recipe_id)
    .maybeSingle();

  if (!parentBatch) {
    return NextResponse.json({ error: "Parent batch not found." }, { status: 404 });
  }

  // 1. Create the child batch
  const { data: childBatch, error: batchErr } = await supabase
    .from("brew_batches")
    .insert({
      beer_name,
      planned_brew_date:       parentBatch.planned_brew_date,
      volume_bbl,
      status:                  "fermenting",
      recipe_id,
      notes:                   notes || null,
      converted_from_batch_id: batch_id,
      converted_volume_bbl:    volume_bbl,
    })
    .select("id, batch_number")
    .single();

  if (batchErr || !childBatch) {
    return NextResponse.json({ error: batchErr?.message ?? "Failed to create child batch" }, { status: 500 });
  }

  // 2. Record the conversion transfer on the parent batch
  const { data: transfer, error: transferErr } = await supabase
    .from("batch_transfers")
    .insert({
      batch_id,
      from_tank_id,
      to_tank_id,
      volume_bbl,
      shrinkage_bbl: 0,
      transfer_type: "conversion",
      notes:         notes || null,
      to_batch_id:   childBatch.id,
    })
    .select("id")
    .single();

  if (transferErr) {
    // Roll back the child batch
    await supabase.from("brew_batches").delete().eq("id", childBatch.id);
    return NextResponse.json({ error: transferErr.message }, { status: 500 });
  }

  // 3. Assign child batch to destination fermenter
  const { error: assignErr } = await supabase
    .from("batch_tank_assignments")
    .insert({ batch_id: childBatch.id, tank_id: to_tank_id });

  if (assignErr) {
    return NextResponse.json({ error: assignErr.message }, { status: 500 });
  }

  // 3b. Create a schedule entry for the child batch so it appears on the Gantt
  // and the fermenter's capacity is correctly reserved.
  {
    const today = new Date().toISOString().split("T")[0];
    const daysInFermenter = childRecipe?.days_fermenter ?? 14;
    const plannedEnd = new Date();
    plannedEnd.setDate(plannedEnd.getDate() + Math.max(0, daysInFermenter - 1));
    await supabase.from("batch_schedule_entries").insert({
      batch_id:      childBatch.id,
      equipment_id:  to_tank_id,
      stage:         "fermenting",
      planned_start: today,
      planned_end:   plannedEnd.toISOString().slice(0, 10),
      actual_start:  today,
      volume_bbl:    volume_bbl,
      notes:         `Auto-created on conversion from ${batch_id}`,
    });
  }

  // 4. Release the parent's current tank assignment (mirrors record_batch_transfer RPC)
  await supabase
    .from("batch_tank_assignments")
    .update({ released_at: new Date().toISOString() })
    .eq("batch_id", batch_id)
    .eq("tank_id", from_tank_id)
    .is("released_at", null);

  // 5. Re-insert parent's assignment if volume remains in the source tank
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

  const isFullConversion = netInTank <= 0.001;

  if (!isFullConversion) {
    const { error: reassignErr } = await supabase
      .from("batch_tank_assignments")
      .insert({ batch_id, tank_id: from_tank_id });
    if (reassignErr && reassignErr.code !== "23505") {
      return NextResponse.json({ error: reassignErr.message }, { status: 500 });
    }
  } else {
    // Full conversion — archive the parent batch
    await supabase.from("brew_batches").update({ status: "archived" }).eq("id", batch_id);

    // Close any open schedule entries on the parent
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "fully converted" })
      .eq("batch_id", batch_id)
      .is("cancelled_at", null)
      .is("actual_end", null);

    await supabase.from("batch_status_history").insert({
      batch_id,
      status:     "archived",
      note:       `Fully converted — all ${volume_bbl} BBL transferred to ${childBatch.batch_number}`,
      changed_by: currentUser?.id ?? null,
    });
  }

  // 6. Status history entry for the child batch
  await supabase.from("batch_status_history").insert({
    batch_id:   childBatch.id,
    status:     "fermenting",
    note:       `Converted from batch — ${volume_bbl} BBL split`,
    changed_by: currentUser?.id ?? null,
  });

  return NextResponse.json({ transfer: transfer.id, child_batch: childBatch }, { status: 201 });
}
