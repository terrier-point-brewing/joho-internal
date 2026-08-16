import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { issueDepositReduction, RefundError } from "@/lib/finance/issueRefund";

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
  // `square_refunds` is finance-reader-only under RLS, but this endpoint is
  // gated on `exportOperate` — so the brewer entitled to reduce an allocation
  // could move the money and then be refused the row that records it, leaving a
  // real refund off the books. The capability check above is the authority on
  // who may do this; the finance write goes through the admin client, exactly
  // as the sibling invoice refund route does. Reads stay user-scoped.
  const admin = createSupabaseAdminClient();
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

  // 4. Hand off to the shared refund service. The proportional math lives there
  // now, unchanged — against the amount actually paid, never a fresh
  // calculateIngredientDeposit() at current ingredient costs — but the refund is
  // recorded in `square_refunds` alongside every other kind, tagged
  // `deposit_reduction`, instead of only in this allocation's three columns.
  const currentPercentage = Number(allocation.percentage);
  const paidCents = Number(allocation.deposit_amount_paid_cents);

  let refund;
  try {
    refund = await issueDepositReduction(admin, {
      allocationId: id,
      currentPercentage,
      newPercentage,
      paidCents,
      squarePaymentId: allocation.square_payment_id,
      squareOrderId: allocation.square_deposit_order_id ?? null,
    });
  } catch (e: unknown) {
    // `moneyMoved` rides along so the modal can tell the operator whether they
    // may try again. It is the difference between a typo they can correct and a
    // refund they must not issue twice.
    if (e instanceof RefundError) {
      return NextResponse.json({ error: e.message, moneyMoved: e.moneyMoved }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Square refund failed", moneyMoved: true },
      { status: 500 }
    );
  }
  const refundAmountCents = refund.refundAmountCents;

  // Only write the row once the refund has actually succeeded. Admin client for
  // the same reason as the refund record: past this point the money is gone, and
  // a write that a policy can refuse is a write that strands it.
  const { data: updated, error: updateErr } = await admin
    .from("batch_allocations")
    .update({
      percentage: newPercentage,
      square_refund_id: refund.squareRefundId,
      refund_amount_cents: refundAmountCents,
      refunded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json(
      { error: `Refund succeeded (id: ${refund.squareRefundId}) and is recorded, but saving the new percentage failed: ${updateErr.message}. Do NOT retry the refund — set the allocation to ${newPercentage}% by hand.`, moneyMoved: true },
      { status: 500 }
    );
  }

  return NextResponse.json({ allocation: updated, refundAmountCents, refundId: refund.squareRefundId });
}
