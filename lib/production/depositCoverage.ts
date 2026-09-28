/**
 * Who has actually paid for a conversion child's ingredients — decomposed and
 * displayable, so "should this export invoice charge base?" stops being a
 * judgment buried in code.
 *
 * A conversion child's deposit splits into two components:
 *  - BASE: the parent beer's bill. The child skips it only when the parent's
 *    paid deposit was carried over to the child (transfer-coverage). Otherwise
 *    — no transfer, or the parent deposit was refunded — nobody has paid for
 *    that grain and the child's deposit must charge it (rules agreed
 *    2026-09-13 and 2026-09-28).
 *  - ADDITIONS: the child recipe's own delta (the ginger, the orange). Billed
 *    through the child allocation's own deposit invoice or back-charged onto
 *    its export invoice.
 *
 * The pure classifiers here feed BOTH the display (a coverage line on the
 * allocation cards) and the billing decision (conversionDepositExclusions
 * keeps the base exclusion only for a transferred, unrefunded parent deposit) — one source,
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

export type AdditionsStatus = "settled" | "pending_invoice" | "collecting" | "uncharged" | "written_off";
export type BaseStatus = "not_conversion" | "covered" | "refunded_chargeable" | "pending_parent" | "uncovered";

export interface AdditionsCoverage {
  status: AdditionsStatus;
  /** How the settled/pending charge is carried. */
  via: "backcharge" | "own_invoice" | null;
  /** Cents billed on export invoices so far (non-voided); 0 when none. */
  chargedCents: number;
  /** Cents of that actually paid. */
  collectedCents: number;
}

/** Per-invoice back-charges, from lib/production/depositCharges. */
export interface CoverageCharges {
  chargedCents: number;
  collectedCents: number;
  unpaidCount: number;
}

export interface BaseCoverage {
  status: BaseStatus;
  /** Cents refunded on the parent's deposit, when that is what voids coverage. */
  parentRefundCents: number | null;
}

/**
 * The allocation's own deposit state.
 *
 * A back-charged deposit is collected per export invoice as the beer ships,
 * so "paid" is not one event: `collecting` means every charge raised so far
 * has been paid but the allocation is not fully delivered, so the next
 * shipment's invoice will carry another share. `invoice_paid_at` is the
 * settled mark — set by a paid deposit invoice, or by the settle path once
 * the last back-charge is paid on a fully delivered allocation.
 */
export function classifyAdditions(a: CoverageAllocFields, charges?: CoverageCharges | null): AdditionsCoverage {
  const chargedCents = charges?.chargedCents ?? 0;
  const collectedCents = charges?.collectedCents ?? 0;
  const backcharged = !!a.deposit_backcharged_invoice_id || chargedCents > 0;
  if (a.written_off_at) return { status: "written_off", via: null, chargedCents, collectedCents };
  const via: AdditionsCoverage["via"] = backcharged
    ? "backcharge"
    : a.square_deposit_invoice_id ? "own_invoice" : null;
  if (a.invoice_paid_at) return { status: "settled", via, chargedCents, collectedCents };
  if (chargedCents > 0) {
    return {
      status: (charges?.unpaidCount ?? 0) > 0 ? "pending_invoice" : "collecting",
      via: "backcharge",
      chargedCents,
      collectedCents,
    };
  }
  if (a.deposit_backcharged_invoice_id || a.invoice_sent_at || a.invoice_generated_at) {
    return { status: "pending_invoice", via, chargedCents, collectedCents };
  }
  return { status: "uncharged", via: null, chargedCents, collectedCents };
}

/**
 * Whether the base bill behind a conversion child is paid for, judged from the
 * PARENT batch's matching contract allocation. The parent's deposit covers the
 * child's base ONLY when it was carried over to the child
 * (`coverageTransferred` — the transfer-coverage route's invoice_batch_links
 * row). A parent share that merely exists paid for the beer that stayed the
 * parent recipe, not the liquid that was converted, so without a transfer the
 * child's own deposit bills the full bill (`uncovered`).
 */
export function classifyBase(
  isConversionChild: boolean,
  parent: CoverageAllocFields | null,
  coverageTransferred = false,
): BaseCoverage {
  if (!isConversionChild) return { status: "not_conversion", parentRefundCents: null };
  if (!parent) return { status: "uncovered", parentRefundCents: null };
  const refund = Number(parent.refund_amount_cents ?? 0);
  if (refund > 0) return { status: "refunded_chargeable", parentRefundCents: refund };
  if (!coverageTransferred) return { status: "uncovered", parentRefundCents: null };
  if (parent.invoice_paid_at || parent.written_off_at) return { status: "covered", parentRefundCents: null };
  return { status: "pending_parent", parentRefundCents: null };
}
