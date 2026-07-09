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

  // Only settled cash counts — a failed/pending ACH pull never moved money and
  // must not enter the ledger. Non-completed transfers are dropped (a later
  // idempotent sync picks them up once they complete).
  const rows = transfers
    .filter((t) => t.status.toUpperCase() === "COMPLETED")
    .map((t) => ({
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

  // Pass 2: several leftover transfers that together pay ONE statement (partial
  // payments). Reconcile the leftover sum against a SINGLE remaining charge —
  // never against the sum of multiple unrelated statements — so a coincidental
  // cross-period total can't sweep transfers out of manual review. Anything that
  // doesn't reconcile stays `unclassified`.
  const leftover = rows.filter((r) => r.flow_type === "unclassified");
  if (leftover.length > 1) {
    const leftoverSum = leftover.reduce((s, r) => s + r.cents, 0);
    const idx = remainingCharges.indexOf(leftoverSum);
    if (idx >= 0) {
      remainingCharges.splice(idx, 1);
      for (const r of leftover) r.flow_type = "card_settlement";
    }
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
