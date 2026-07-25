import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createRefund } from "@/lib/square/refunds";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

// POST /api/production/allocations/[id]/adjust
// Reduces a paid allocation's percentage and issues a proportional Square
// refund against the originally captured payment. This is a distinct
// workflow from the plain PATCH route because it has a real financial
// side effect — increasing percentage is explicitly out of scope here.
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();
  const newPercentage = Number(body.new_percentage);

  if (body.new_percentage == null || isNaN(newPercentage)) {
    return NextResponse.json({ error: "new_percentage is required" }, { status: 400 });
  }

  const { data: allocation, error: fetchErr } = await supabase
    .from("batch_allocations")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !allocation) {
    return NextResponse.json({ error: "Allocation not found" }, { status: 404 });
  }

  // 1. Must have a paid invoice — that's the only state this endpoint handles.
  if (!allocation.invoice_paid_at) {
    return NextResponse.json(
      { error: "This allocation does not have a paid invoice — use the regular PATCH route to edit it instead." },
      { status: 400 }
    );
  }

  // 2. Only decreases are supported by this endpoint.
  if (newPercentage >= Number(allocation.percentage)) {
    return NextResponse.json(
      { error: "Increasing a paid allocation's percentage isn't supported here — create an additional commitment or use an ad-hoc export instead." },
      { status: 400 }
    );
  }

  // 3. Must have a captured payment ID to refund against.
  if (!allocation.square_payment_id || allocation.deposit_amount_paid_cents == null) {
    return NextResponse.json(
      { error: "No Square payment ID is on file for this allocation (it was likely paid before refund tracking shipped) — handle this refund manually via the Square Dashboard." },
      { status: 422 }
    );
  }

  // 4. Pure proportional math against the amount actually paid — never a
  // fresh calculateIngredientDeposit() call against current ingredient costs.
  const currentPercentage = Number(allocation.percentage);
  const paidCents = Number(allocation.deposit_amount_paid_cents);

  if (currentPercentage <= 0) {
    return NextResponse.json(
      { error: "Allocation has an invalid percentage (<= 0) — cannot compute refund. Contact support." },
      { status: 500 }
    );
  }

  const refundAmountCents = Math.round(paidCents * (1 - newPercentage / currentPercentage));

  const reason = `Allocation percentage reduced from ${currentPercentage}% to ${newPercentage}%`;

  let refund;
  try {
    refund = await createRefund(allocation.square_payment_id, refundAmountCents, reason);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Square refund failed" },
      { status: 500 }
    );
  }

  // Only write the row once the refund has actually succeeded.
  const { data: updated, error: updateErr } = await supabase
    .from("batch_allocations")
    .update({
      percentage: newPercentage,
      square_refund_id: refund.refundId,
      refund_amount_cents: refundAmountCents,
      refunded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json(
      { error: `Refund succeeded (id: ${refund.refundId}) but saving the new percentage failed: ${updateErr.message}. Do not retry the refund — fix the allocation row manually.` },
      { status: 500 }
    );
  }

  return NextResponse.json({ allocation: updated, refundAmountCents, refundId: refund.refundId });
}
