/**
 * Ramp Business Account transfers → bank-ledger records. These transfers are the
 * ACH pulls that settle the monthly card statement, but the /transfers endpoint
 * carries no description/counterparty, so we recover the card-statement link by
 * reconciling transfer amounts against statement CHARGES (the amount autopaid).
 *
 * A statement may be paid by one transfer or several, so matching is two-pass:
 * exact single matches first, then a remaining-sum reconciliation. Whatever
 * doesn't reconcile is left `unclassified` for manual review — never auto-booked.
 * Either way these are non-P&L: the underlying card charges are already counted
 * once via the card-transaction sync, so booking the settlement is excluded.
 */
import { dollarsToCents } from "./expenses";
import type { BankLedgerRecord } from "./bankLedger";
import type { RampTransfer, RampStatement } from "@/lib/ramp";

export type TransferFlow = "card_settlement" | "unclassified";

export interface TransferClassification {
  transfer:  RampTransfer;
  flow_type: TransferFlow;
}

/**
 * Reconcile transfers against card-statement charges. A transfer is
 * `card_settlement` when its amount equals a statement's charges, or when the
 * still-unmatched transfers collectively sum to the still-unmatched charges;
 * otherwise `unclassified`.
 */
export function classifyTransfers(
  transfers: RampTransfer[],
  statements: RampStatement[],
): TransferClassification[] {
  const remainingCharges = statements.map((s) => dollarsToCents(s.charges)).filter((c) => c > 0);

  const rows = transfers.map((t) => ({
    transfer:  t,
    cents:     dollarsToCents(t.amount),
    flow_type: "unclassified" as TransferFlow,
  }));

  // Pass 1: exact single matches, each consuming one statement charge.
  for (const r of rows) {
    const idx = remainingCharges.indexOf(r.cents);
    if (idx >= 0) {
      r.flow_type = "card_settlement";
      remainingCharges.splice(idx, 1);
    }
  }

  // Pass 2: the leftover transfers reconcile in aggregate to the leftover
  // charges (a statement paid by several transfers). Only tag when the totals
  // match exactly — otherwise leave them for review.
  const leftover = rows.filter((r) => r.flow_type === "unclassified");
  const leftoverSum = leftover.reduce((s, r) => s + r.cents, 0);
  const remChargeSum = remainingCharges.reduce((s, c) => s + c, 0);
  if (leftover.length > 0 && remChargeSum > 0 && leftoverSum === remChargeSum) {
    for (const r of leftover) r.flow_type = "card_settlement";
  }

  return rows.map(({ transfer, flow_type }) => ({ transfer, flow_type }));
}

/** Shape a classified transfer into a non-P&L, outflow-negative bank-ledger row. */
export function transferToLedgerRecord(t: RampTransfer, flow_type: TransferFlow): BankLedgerRecord {
  return {
    source:                   "ramp",
    source_transaction_id:    t.id,
    amount_cents:             -dollarsToCents(t.amount),   // outflow
    currency_code:            "USD",
    description:              flow_type === "card_settlement" ? "Card statement payment" : "Transfer",
    counterparty_name:        null,
    source_account_name:      null,
    destination_account_name: null,
    flow_type,
    affects_pl:               false,
    transaction_date:         t.created_at ? t.created_at.slice(0, 10) : null,
  };
}
