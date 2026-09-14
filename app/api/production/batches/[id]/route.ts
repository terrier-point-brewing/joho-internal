import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requirePermission, CAP } from "@/lib/auth";
import { upsertCommitments, releaseCommitments } from "@/lib/production/commitments";
import { recheckBatchCommitments } from "@/lib/production/commitmentFulfillment";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const { id } = await params;
  const body = await req.json();

  // Whitelist updatable columns — never trust the raw body (prevents
  // overwriting id/batch_number/created_at via mass assignment).
  const UPDATABLE = [
    "beer_name", "planned_brew_date", "expected_delivery_date",
    "volume_bbl", "turns", "status", "notes", "recipe_id",
    "ibu", "color_srm", "original_gravity", "final_gravity", "dissolved_oxygen_ppb",
  ] as const;
  const updates: Record<string, unknown> = {};
  for (const col of UPDATABLE) {
    if (col in body) updates[col] = body[col];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updatable fields provided" }, { status: 400 });
  }

  // Fetch current row to detect status changes and re-evaluate commitments.
  const { data: current } = await supabase
    .from("brew_batches")
    .select("status, recipe_id, volume_bbl, turns")
    .eq("id", id)
    .single();

  // The planned volume is the denominator of every allocation's percentage
  // (booked ÷ planned) and of every deposit invoice's description. Once a
  // deposit has been drafted or paid on this batch, restating the volume
  // silently restates what the partner bought. Refuse; the allocation and its
  // invoice are the things to change.
  const volumeChanged = "volume_bbl" in updates
    && Number(updates.volume_bbl) !== Number(current?.volume_bbl ?? NaN);
  if (volumeChanged) {
    const { data: deposited } = await supabase
      .from("batch_allocations")
      .select("id, invoice_paid_at, invoice_generated_at, deposit_backcharged_invoice_id")
      .eq("batch_id", id)
      .eq("channel", "contract_brewing")
      .or("invoice_paid_at.not.is.null,invoice_generated_at.not.is.null,deposit_backcharged_invoice_id.not.is.null");
    if ((deposited ?? []).length > 0) {
      return NextResponse.json(
        { error: "This batch has a contract allocation whose deposit has been drafted or paid, so its planned volume is locked. Adjust the allocation (or refund part of the deposit) instead of restating the batch." },
        { status: 422 },
      );
    }
  }

  const { error } = await supabase
    .from("brew_batches")
    .update(updates)
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const newStatus: string | undefined = body.status;
  const statusChanged = newStatus && current?.status !== newStatus;

  // Owed = percentage × produced, capped at booked — produced does not move
  // here, but a volume change moves the booked ÷ planned reading everywhere;
  // re-judge the batch's commitments so nothing sits on a stale figure.
  if (volumeChanged) await recheckBatchCommitments(supabase, id);

  // Log status change
  if (statusChanged) {
    await supabase.from("batch_status_history").insert({
      batch_id:   id,
      status:     newStatus,
      note:       body.status_note ?? null,
      changed_by: currentUser?.id ?? null,
    });
  }

  // Re-compute ingredient commitments when the recipe or the turn count changes.
  // Volume is deliberately NOT a trigger: the grain bill is per brewhouse turn,
  // so editing a batch's expected liquid yield must not move what it reserves.
  const recipeChanged = "recipe_id" in updates && updates.recipe_id !== current?.recipe_id;
  const turnsChanged  = "turns"     in updates && updates.turns     !== current?.turns;
  if (recipeChanged || turnsChanged) {
    const effectiveRecipeId = (updates.recipe_id as string | undefined) ?? current?.recipe_id;
    const effectiveTurns    = (updates.turns     as number | undefined) ?? current?.turns;
    if (effectiveRecipeId) {
      await upsertCommitments(supabase, id, effectiveRecipeId, Math.max(1, Number(effectiveTurns ?? 1)));
    }
  }

  // Archive cascade: release operational records but preserve financial ones.
  if (statusChanged && newStatus === "complete") {
    // Release any active tank assignments — tank is no longer occupied.
    await supabase
      .from("batch_tank_assignments")
      .update({ released_at: new Date().toISOString() })
      .eq("batch_id", id)
      .is("released_at", null);

    // Cancel open schedule entries that haven't actually ended yet.
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "batch completed" })
      .eq("batch_id", id)
      .is("cancelled_at", null)
      .is("actual_end", null);

    // Release ingredient commitments — batch is cancelled.
    await releaseCommitments(supabase, id);

    // Fulfillment is gated on batch completion, so exports shipped before this
    // moment were never judged — evaluate the batch's commitments now.
    await recheckBatchCommitments(supabase, id);

    // batch_allocations, export_transactions, batch_transfers, batch_status_history,
    // and batch_brew_activity_log are intentionally left untouched — they are
    // financial or historical records and must not be invalidated on completion.
  }

  const { data, error: fetchErr } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, expected_yield_bbl, partner:contract_brewing_partners(company_name)), batch_status_history(*), batch_brew_activity_log:brew_activities(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .eq("id", id)
    .single();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hard delete is admin-only. All child records cascade via FK constraints.
  try { await requirePermission(CAP.batchDelete); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  // Deleting a batch cascades to its allocations AND its export rows — one
  // call could erase shipped beer, excise history and a paid deposit. A batch
  // with any of those is a record, not a draft: refuse and say what holds it.
  const [{ count: shipments }, { data: paidAllocs }] = await Promise.all([
    supabase.from("export_transactions").select("id", { count: "exact", head: true }).eq("batch_id", id),
    supabase.from("batch_allocations").select("id").eq("batch_id", id).not("invoice_paid_at", "is", null),
  ]);
  const holds: string[] = [];
  if ((shipments ?? 0) > 0) holds.push(`${shipments} shipment${shipments === 1 ? "" : "s"}`);
  if ((paidAllocs ?? []).length > 0) holds.push(`${paidAllocs!.length} paid deposit${paidAllocs!.length === 1 ? "" : "s"}`);
  if (holds.length > 0) {
    return NextResponse.json(
      { error: `This batch has ${holds.join(" and ")} on record and cannot be deleted. Complete it, or reverse the shipments and refund the deposits first.` },
      { status: 409 },
    );
  }

  const { error } = await supabase.from("brew_batches").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
