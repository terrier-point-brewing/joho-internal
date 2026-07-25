import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// PATCH /api/production/allocations/[id]
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }


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

  // A paid allocation cannot have its percentage reduced (use the adjust endpoint for refunds)
  if (current.invoice_paid_at && body.percentage != null && Number(body.percentage) < Number(current.percentage)) {
    return NextResponse.json(
      { error: "This allocation has a paid invoice and its percentage cannot be reduced directly. Use the refund adjustment flow instead." },
      { status: 422 }
    );
  }

  // A paid allocation cannot have its percentage changed at all
  if (current.invoice_paid_at && body.percentage != null && Number(body.percentage) !== Number(current.percentage)) {
    return NextResponse.json(
      { error: "This allocation has a paid invoice and cannot be adjusted. Contact support for a partial refund or additional invoice." },
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
  if (body.percentage != null) update.percentage = Number(body.percentage);
  if (body.notes !== undefined) update.notes = body.notes || null;
  if (body.partner_id !== undefined) update.partner_id = body.partner_id || null;
  if (body.contract_request_id !== undefined) update.contract_request_id = body.contract_request_id || null;

  // When percentage changes on a contract_brewing allocation that has a generated
  // (but not paid) deposit invoice, mark the invoice as stale by clearing its
  // sent/generated timestamps so the user must regenerate via the invoice modal.
  // This keeps the PATCH handler fast and Square-API-free.
  const percentageChanged =
    body.percentage != null && Number(body.percentage) !== Number(current.percentage);
  if (
    percentageChanged &&
    current.channel === "contract_brewing" &&
    current.square_deposit_invoice_id &&
    !current.invoice_paid_at
  ) {
    update.invoice_generated_at = null;
    update.invoice_sent_at = null;
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
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  const { data: current, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("invoice_paid_at")
    .eq("id", id)
    .single();

  if (fetchErr || !current) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  if (current.invoice_paid_at) {
    return NextResponse.json({ error: "Cannot delete an allocation with a paid invoice." }, { status: 422 });
  }

  const { error } = await supabase.from("batch_allocations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
