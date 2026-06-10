import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// PATCH /api/production/allocations/[id]
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();

  // Fetch current record to enforce lock rules
  const { data: current, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !current) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  // A locked allocation cannot have its percentage reduced
  if (current.locked && body.percentage != null && Number(body.percentage) < Number(current.percentage)) {
    return NextResponse.json(
      { error: "This allocation is locked and its percentage cannot be reduced." },
      { status: 422 }
    );
  }

  // If increasing percentage, validate total across batch won't exceed 100
  if (body.percentage != null && Number(body.percentage) !== Number(current.percentage)) {
    const { data: siblings } = await supabase
      .from("batch_allocations")
      .select("percentage")
      .eq("batch_id", current.batch_id)
      .neq("id", id);

    const siblingsTotal = (siblings ?? []).reduce((s, a) => s + Number(a.percentage), 0);
    if (siblingsTotal + Number(body.percentage) > 100) {
      return NextResponse.json(
        { error: `Setting ${body.percentage}% would exceed 100% for this batch (siblings total: ${siblingsTotal.toFixed(2)}%)` },
        { status: 422 }
      );
    }
  }

  // Build update payload — only allow safe fields to be updated
  const update: Record<string, unknown> = {};
  if (body.label != null) update.label = body.label;
  if (body.percentage != null) update.percentage = Number(body.percentage);
  if (body.notes !== undefined) update.notes = body.notes || null;
  if (body.partner_id !== undefined) update.partner_id = body.partner_id || null;
  if (body.contract_request_id !== undefined) update.contract_request_id = body.contract_request_id || null;

  // Lock / unlock logic
  if (body.locked === true && !current.locked) {
    if (!body.lock_reason || !["deposit_paid", "contract_signed"].includes(body.lock_reason)) {
      return NextResponse.json({ error: "lock_reason must be 'deposit_paid' or 'contract_signed'" }, { status: 400 });
    }
    update.locked = true;
    update.lock_reason = body.lock_reason;
    update.locked_at = new Date().toISOString();
  }
  // Unlocking is only allowed if the caller explicitly passes locked: false and lock_reason is null
  if (body.locked === false) {
    update.locked = false;
    update.lock_reason = null;
    update.locked_at = null;
  }

  const { data, error } = await supabase
    .from("batch_allocations")
    .update(update)
    .eq("id", id)
    .select(`
      *,
      brew_batches(id, beer_name, batch_number, volume_bbl),
      contract_brewing_partners(id, company_name)
    `)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/production/allocations/[id]
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  const { data: current, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("locked")
    .eq("id", id)
    .single();

  if (fetchErr || !current) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  if (current.locked) {
    return NextResponse.json({ error: "Cannot delete a locked allocation." }, { status: 422 });
  }

  const { error } = await supabase.from("batch_allocations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
