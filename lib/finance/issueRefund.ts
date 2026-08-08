/**
 * Issue a refund against an invoice — the one path every app-issued refund
 * takes.
 *
 * Order of operations is not negotiable, and is inherited from the allocation
 * adjust route that predates this module:
 *
 *   plan → call Square → ONLY THEN write.
 *
 * A refund is real the moment Square accepts it. Writing first would leave a
 * credit on the books that never happened; retrying after a write failure would
 * refund the customer twice. So a write failure after a successful refund is
 * reported loudly, with the refund id, and is never retried.
 *
 * The record it writes is the SAME record `syncRefunds` writes when someone
 * refunds in the Square dashboard instead — one table, one shape. The only
 * difference is that this path knows which lines the money came off, and stamps
 * `reason_code` at birth. See supabase/migrations/20261005090000_unified_refunds.sql.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createRefund } from "@/lib/square/refunds";
import { getOrderPayment } from "@/lib/square/square-invoices";
import { resolveInvoiceLineVolumes } from "@/lib/production/invoiceLineVolumes";
import { writeRefundReturn, type RefundReturnResult } from "@/lib/production/refundReturn";
import {
  planRefund,
  type RefundReason,
  type RefundSelection,
  type RefundableLine,
  type RefundPlan,
} from "./refundPlanner";

export interface IssueRefundParams {
  invoiceId: string;
  reason: RefundReason;
  selections: RefundSelection[];
  /** Free text shown on the Square refund. Optional. */
  note?: string | null;
  /** The user issuing it, stamped for audit. */
  userId?: string | null;
}

export interface IssueRefundResult {
  refundId: string;
  squareRefundId: string;
  totalCents: number;
  recreditsInventory: boolean;
  reversesExcise: boolean;
  /** What the return actually moved. Null when the reason moves nothing. */
  consequences: RefundReturnResult | null;
  /** Non-blocking problems the operator needs to know about. */
  warnings: string[];
}

export class RefundError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RefundError";
  }
}

/**
 * Load an invoice's lines in the shape the planner wants, with beer volumes
 * attached where they can be resolved. Exported for the modal's preview, which
 * must plan against exactly the same inputs the server will.
 */
export async function loadRefundableLines(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<RefundableLine[]> {
  const { data, error } = await supabase
    .from("invoice_line_items")
    .select("id, category, quantity, unit_price_cents, total_cents")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (error) throw new RefundError(`Could not read the invoice's lines: ${error.message}`, 500);

  const volumes = await resolveInvoiceLineVolumes(supabase, invoiceId);

  return (data ?? []).map((l) => ({
    id: l.id,
    category: l.category,
    quantity: Number(l.quantity),
    unitPriceCents: Number(l.unit_price_cents),
    totalCents: Number(l.total_cents),
    volumeBbl: volumes.get(l.id) ?? null,
  }));
}

/** Sum of every refund already recorded against this invoice, in cents. */
async function alreadyRefundedCents(supabase: SupabaseClient, invoiceId: string): Promise<number> {
  const { data, error } = await supabase
    .from("square_refunds")
    .select("amount_cents")
    .eq("invoice_id", invoiceId);
  if (error) throw new RefundError(`Could not read prior refunds: ${error.message}`, 500);
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount_cents), 0);
}

/**
 * Plan without issuing. The modal calls this so its preview and the server's
 * enforcement can never disagree — the server still re-plans independently
 * before it touches Square.
 */
export async function previewRefund(
  supabase: SupabaseClient,
  params: Omit<IssueRefundParams, "userId" | "note">,
): Promise<RefundPlan> {
  const { invoiceId, reason, selections } = params;
  const [lines, refunded, paid] = await Promise.all([
    loadRefundableLines(supabase, invoiceId),
    alreadyRefundedCents(supabase, invoiceId),
    invoicePaidCents(supabase, invoiceId),
  ]);
  if (paid == null) {
    return { ok: false, error: "This invoice has no captured payment to refund against." };
  }
  return planRefund({
    lines,
    selections,
    reason,
    paidCents: paid,
    alreadyRefundedCents: refunded,
  });
}

/** What the customer actually paid, per the invoice ledger. Null if unpaid. */
async function invoicePaidCents(supabase: SupabaseClient, invoiceId: string): Promise<number | null> {
  const { data } = await supabase
    .from("invoices")
    .select("total_cents, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!data) return null;
  // Only a settled invoice has money to give back. `partial` is deliberately
  // excluded: the amount captured is not the invoice total, and refunding
  // against the total would over-refund.
  if (data.status !== "paid") return null;
  return Number(data.total_cents);
}

export async function issueRefund(
  supabase: SupabaseClient,
  params: IssueRefundParams,
): Promise<IssueRefundResult> {
  const { invoiceId, reason, selections, note, userId } = params;

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .select("id, invoice_number, invoice_type, status, total_cents, allocation_id, raw_data")
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr) throw new RefundError(`Could not read the invoice: ${invErr.message}`, 500);
  if (!invoice) throw new RefundError("Invoice not found.", 404);
  if (invoice.status !== "paid") {
    throw new RefundError(
      "Only a paid invoice can be credited — an unpaid one should be edited or voided in Square instead.",
      400,
    );
  }

  // 1. Plan. Every guard lives in the planner; nothing below re-decides.
  const lines = await loadRefundableLines(supabase, invoiceId);
  const refunded = await alreadyRefundedCents(supabase, invoiceId);
  const plan = planRefund({
    lines,
    selections,
    reason,
    paidCents: Number(invoice.total_cents),
    alreadyRefundedCents: refunded,
  });
  if (!plan.ok) throw new RefundError(plan.error, 400);

  // 2. Find the captured payment. An invoice paid before payment ids were
  // recorded has to be handled in the Square dashboard and classified after —
  // which is exactly what the unclassified-refund path is for.
  const squareOrderId = (invoice.raw_data as { square_order_id?: string } | null)?.square_order_id;
  if (!squareOrderId) {
    throw new RefundError(
      "No Square order is on file for this invoice, so there is no payment to refund against. Refund it in the Square dashboard and classify it here afterwards.",
      422,
    );
  }
  const { paymentId } = await getOrderPayment(squareOrderId);
  if (!paymentId) {
    throw new RefundError(
      "Square has no captured payment on this invoice's order. Refund it in the Square dashboard and classify it here afterwards.",
      422,
    );
  }

  // 3. Refund. Past this line the money has moved.
  const squareReason = note?.trim()
    ? note.trim()
    : `${reasonLabel(reason)} — invoice ${invoice.invoice_number ?? invoiceId}`;

  const refund = await createRefund(paymentId, plan.totalCents, squareReason);

  // 4. Write the record. `square_refunds` is upserted on square_refund_id, which
  // is also the key the webhook's syncRefunds upserts on — so the webhook this
  // refund is about to fire updates this row instead of creating a second one.
  const { data: row, error: refundErr } = await supabase
    .from("square_refunds")
    .upsert(
      {
        square_refund_id: refund.refundId,
        square_payment_id: paymentId,
        square_order_id: squareOrderId,
        amount_cents: plan.totalCents,
        currency: "USD",
        status: refund.status,
        reason: squareReason,
        refunded_at: new Date().toISOString(),
        origin: "app",
        reason_code: reason,
        invoice_id: invoiceId,
        allocation_id: invoice.allocation_id ?? null,
      },
      { onConflict: "square_refund_id" },
    )
    .select("id")
    .single();

  if (refundErr || !row) {
    throw new RefundError(
      `The Square refund succeeded (id: ${refund.refundId}) but recording it failed: ${refundErr?.message ?? "unknown error"}. Do NOT retry — the customer has already been refunded. Record it by hand.`,
      500,
    );
  }

  const { error: linesErr } = await supabase.from("refund_lines").insert(
    plan.lines.map((l) => ({
      refund_id: row.id,
      invoice_line_item_id: l.lineId,
      basis: l.basis,
      quantity: l.quantity,
      amount_cents: l.amountCents,
    })),
  );

  if (linesErr) {
    // The refund and its total are recorded and the GL is not wrong, only
    // coarse — it will post to the single contra account until the lines are
    // supplied. Surfaced as the same "needs a reason" state a Square-issued
    // refund lands in, which is recoverable from the UI.
    await supabase
      .from("square_refunds")
      .update({ reason_code: null, origin: "square" })
      .eq("id", row.id);
    throw new RefundError(
      `The Square refund succeeded (id: ${refund.refundId}) and is recorded, but its line detail failed to save: ${linesErr.message}. Do NOT retry the refund — re-classify it from the unclassified refunds list instead.`,
      500,
    );
  }

  if (userId) {
    await supabase.from("square_refunds").update({ classified_by: userId }).eq("id", row.id);
  }

  // 5. Fan out the consequences the reason calls for. Deliberately AFTER the
  // record is safe: if the return write fails, the refund is still on the books
  // and the operator gets a warning naming exactly what to fix, rather than a
  // refund that vanished because a cold-storage row would not budge.
  const { consequences, warnings } = await applyConsequences(supabase, {
    refundId: row.id,
    invoiceId,
    plan,
    note,
  });

  return {
    refundId: row.id,
    squareRefundId: refund.refundId,
    totalCents: plan.totalCents,
    recreditsInventory: plan.recreditsInventory,
    reversesExcise: plan.reversesExcise,
    consequences,
    warnings,
  };
}

/**
 * Write the return, when the reason says beer moved. Shared by `issueRefund`
 * and `classifyRefund` so a refund issued in the Square dashboard and later
 * explained produces exactly the same movements as one issued in the app.
 */
async function applyConsequences(
  supabase: SupabaseClient,
  args: {
    refundId: string;
    invoiceId: string;
    plan: Extract<RefundPlan, { ok: true }>;
    note?: string | null;
  },
): Promise<{ consequences: RefundReturnResult | null; warnings: string[] }> {
  const { refundId, invoiceId, plan, note } = args;
  if (!plan.recreditsInventory && !plan.reversesExcise) {
    return { consequences: null, warnings: [] };
  }
  try {
    const consequences = await writeRefundReturn(supabase, {
      refundId,
      invoiceId,
      unitFraction: plan.unitFraction,
      // never_delivered reverses the paperwork but puts nothing back on a shelf
      // the beer never left.
      restockInventory: plan.reason === "goods_returned",
      reverseExcise: plan.reversesExcise,
      note: note ?? null,
    });
    return { consequences, warnings: consequences.warnings };
  } catch (e) {
    return {
      consequences: null,
      warnings: [
        `The refund is recorded, but writing the return failed: ${e instanceof Error ? e.message : String(e)}. Cold storage and the excise record have NOT been adjusted — re-run the classification once the cause is fixed.`,
      ],
    };
  }
}

/**
 * Supply the missing reason and lines for a refund that arrived from Square
 * unexplained, then run the same consequences an app-issued refund would have.
 *
 * This is the other half of the unified record: no fresh money moves, because
 * Square already moved it. Everything else is identical to `issueRefund`.
 */
export async function classifyRefund(
  supabase: SupabaseClient,
  params: IssueRefundParams & { refundId: string },
): Promise<Omit<IssueRefundResult, "squareRefundId">> {
  const { refundId, invoiceId, reason, selections, userId } = params;

  const { data: refund, error: refundErr } = await supabase
    .from("square_refunds")
    .select("id, amount_cents, reason_code, invoice_id")
    .eq("id", refundId)
    .maybeSingle();
  if (refundErr) throw new RefundError(`Could not read the refund: ${refundErr.message}`, 500);
  if (!refund) throw new RefundError("Refund not found.", 404);
  if (refund.reason_code) {
    throw new RefundError("This refund has already been classified.", 409);
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("total_cents, status, allocation_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) throw new RefundError("Invoice not found.", 404);

  const lines = await loadRefundableLines(supabase, invoiceId);
  // This refund's own amount is excluded from "already refunded" — it is the one
  // being explained, not a prior one.
  const priorCents = (await alreadyRefundedCents(supabase, invoiceId)) - Number(refund.amount_cents);

  const plan = planRefund({
    lines,
    selections,
    reason,
    paidCents: Number(invoice.total_cents),
    alreadyRefundedCents: Math.max(0, priorCents),
  });
  if (!plan.ok) throw new RefundError(plan.error, 400);

  // The classification must account for the money Square actually moved. A plan
  // that comes to a different number means the lines chosen are not what was
  // refunded, and silently accepting it would leave the GL split not tying to
  // the refund total.
  if (plan.totalCents !== Number(refund.amount_cents)) {
    throw new RefundError(
      `The lines selected come to ${plan.totalCents} cents but Square refunded ${refund.amount_cents}. Adjust the selection until the two agree.`,
      400,
    );
  }

  const { error: linesErr } = await supabase.from("refund_lines").insert(
    plan.lines.map((l) => ({
      refund_id: refundId,
      invoice_line_item_id: l.lineId,
      basis: l.basis,
      quantity: l.quantity,
      amount_cents: l.amountCents,
    })),
  );
  if (linesErr) throw new RefundError(`Saving the line detail failed: ${linesErr.message}`, 500);

  const { error: updErr } = await supabase
    .from("square_refunds")
    .update({
      reason_code: reason,
      invoice_id: invoiceId,
      allocation_id: invoice.allocation_id ?? null,
      classified_at: new Date().toISOString(),
      classified_by: userId ?? null,
    })
    .eq("id", refundId);
  if (updErr) throw new RefundError(`Saving the classification failed: ${updErr.message}`, 500);

  const { consequences, warnings } = await applyConsequences(supabase, {
    refundId,
    invoiceId,
    plan,
    note: params.note,
  });

  return {
    refundId,
    totalCents: plan.totalCents,
    recreditsInventory: plan.recreditsInventory,
    reversesExcise: plan.reversesExcise,
    consequences,
    warnings,
  };
}

/**
 * Reduce a paid allocation's percentage and refund the difference.
 *
 * The third entry point, and the one that predates the others. It keeps its own
 * arithmetic — proportional against the deposit ACTUALLY PAID, never a fresh
 * calculateIngredientDeposit() at today's ingredient costs — because that is the
 * right math for a deposit and there are no invoice lines to credit. What it no
 * longer keeps is its own record: the refund lands in `square_refunds` like
 * every other, tagged `deposit_reduction`, so "what have we refunded and why"
 * has one answer.
 *
 * Returns the new percentage's deposit alongside the refund so the caller can
 * persist the allocation.
 */
export async function issueDepositReduction(
  supabase: SupabaseClient,
  params: {
    allocationId: string;
    currentPercentage: number;
    newPercentage: number;
    paidCents: number;
    squarePaymentId: string;
    squareOrderId?: string | null;
  },
): Promise<{ refundId: string; squareRefundId: string; refundAmountCents: number }> {
  const { allocationId, currentPercentage, newPercentage, paidCents, squarePaymentId } = params;

  if (currentPercentage <= 0) {
    throw new RefundError("Allocation has an invalid percentage (<= 0) — cannot compute refund.", 500);
  }
  if (newPercentage >= currentPercentage) {
    throw new RefundError(
      "Increasing a paid allocation's percentage isn't supported here — create an additional commitment or use an ad-hoc export instead.",
      400,
    );
  }

  const refundAmountCents = Math.round(paidCents * (1 - newPercentage / currentPercentage));
  const reason = `Allocation percentage reduced from ${currentPercentage}% to ${newPercentage}%`;

  const refund = await createRefund(squarePaymentId, refundAmountCents, reason);

  const { data: row, error } = await supabase
    .from("square_refunds")
    .upsert(
      {
        square_refund_id: refund.refundId,
        square_payment_id: squarePaymentId,
        square_order_id: params.squareOrderId ?? null,
        amount_cents: refundAmountCents,
        currency: "USD",
        status: refund.status,
        reason,
        refunded_at: new Date().toISOString(),
        origin: "app",
        reason_code: "deposit_reduction",
        allocation_id: allocationId,
      },
      { onConflict: "square_refund_id" },
    )
    .select("id")
    .single();

  if (error || !row) {
    throw new RefundError(
      `The Square refund succeeded (id: ${refund.refundId}) but recording it failed: ${error?.message ?? "unknown error"}. Do NOT retry — the partner has already been refunded.`,
      500,
    );
  }

  // A deposit reduction carries no refund_lines: there are no invoice lines to
  // credit, and it moves no beer. It posts to the single contra account, which
  // is the honest posting for a deposit that was never revenue in the first place.
  return { refundId: row.id, squareRefundId: refund.refundId, refundAmountCents };
}

function reasonLabel(reason: RefundReason): string {
  switch (reason) {
    case "price_correction": return "Price correction";
    case "goods_returned":   return "Goods returned";
    case "never_delivered":  return "Never delivered";
    case "deposit_reduction": return "Deposit reduction";
  }
}
