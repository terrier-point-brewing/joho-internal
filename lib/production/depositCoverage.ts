/**
 * Who has actually paid for a conversion child's ingredients — decomposed and
 * displayable, so "should this export invoice charge base?" stops being a
 * judgment buried in code.
 *
 * A conversion child's deposit splits into two components:
 *  - BASE: the parent beer's bill. Consumed (and deposit-billed) where the
 *    liquid was brewed, so the child never re-bills it — UNLESS the parent's
 *    deposit was refunded, in which case nobody has paid for that grain and
 *    the child's export invoice must charge it (rule agreed 2026-09-13).
 *  - ADDITIONS: the child recipe's own delta (the ginger, the orange). Billed
 *    through the child allocation's own deposit invoice or back-charged onto
 *    its export invoice.
 *
 * The pure classifiers here feed BOTH the display (a coverage line on the
 * allocation cards) and the billing decision (conversionDepositExclusions
 * drops the base exclusion when the parent deposit was refunded) — one source,
 * so what the operator sees is what gets charged.
 */

export interface CoverageAllocFields {
  invoice_paid_at: string | null;
  invoice_sent_at: string | null;
  invoice_generated_at: string | null;
  deposit_backcharged_invoice_id: string | null;
  square_deposit_invoice_id: string | null;
  refund_amount_cents: number | null;
  written_off_at?: string | null;
}

export type AdditionsStatus = "settled" | "pending_invoice" | "uncharged" | "written_off";
export type BaseStatus = "not_conversion" | "covered" | "refunded_chargeable" | "pending_parent" | "uncovered";

export interface AdditionsCoverage {
  status: AdditionsStatus;
  /** How the settled/pending charge is carried. */
  via: "backcharge" | "own_invoice" | null;
}

export interface BaseCoverage {
  status: BaseStatus;
  /** Cents refunded on the parent's deposit, when that is what voids coverage. */
  parentRefundCents: number | null;
}

/** The child allocation's own (additions-only) deposit state. */
export function classifyAdditions(a: CoverageAllocFields): AdditionsCoverage {
  if (a.written_off_at) return { status: "written_off", via: null };
  const via: AdditionsCoverage["via"] = a.deposit_backcharged_invoice_id
    ? "backcharge"
    : a.square_deposit_invoice_id ? "own_invoice" : null;
  if (a.invoice_paid_at) return { status: "settled", via };
  if (a.deposit_backcharged_invoice_id || a.invoice_sent_at || a.invoice_generated_at) {
    return { status: "pending_invoice", via };
  }
  return { status: "uncharged", via: null };
}

/**
 * Whether the base bill behind a conversion child is paid for, judged from the
 * PARENT batch's matching contract allocation. `refunded_chargeable` is the
 * one state where the child's invoices must charge base: the parent's deposit
 * money went back, so nothing covers that grain any more.
 */
export function classifyBase(
  isConversionChild: boolean,
  parent: CoverageAllocFields | null,
): BaseCoverage {
  if (!isConversionChild) return { status: "not_conversion", parentRefundCents: null };
  if (!parent) return { status: "uncovered", parentRefundCents: null };
  const refund = Number(parent.refund_amount_cents ?? 0);
  if (refund > 0) return { status: "refunded_chargeable", parentRefundCents: refund };
  if (parent.invoice_paid_at || parent.written_off_at) return { status: "covered", parentRefundCents: null };
  if (parent.deposit_backcharged_invoice_id || parent.invoice_sent_at || parent.invoice_generated_at) {
    return { status: "pending_parent", parentRefundCents: null };
  }
  // The parent's own deposit is simply not billed yet — it will be, on the
  // parent's side; the child still never re-bills the base.
  return { status: "pending_parent", parentRefundCents: null };
}
