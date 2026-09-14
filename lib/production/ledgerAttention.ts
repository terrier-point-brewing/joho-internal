import type { LedgerCommitment } from "./partnerLedger";

/**
 * What a commitment needs from a human right now, ranked.
 *
 * The ledger used to show every number for every deal and leave the reader
 * to work out which ones mattered. This is the rule instead: one ordered list
 * of flags per commitment, most expensive first, so the table can sort on it
 * and the row can say it in words. Money before volume. Due dates are shown,
 * never flagged — a desired delivery date is a wish, not a deadline.
 */
export type AttentionKind =
  | "not_invoiced"        // beer left, no export invoice
  | "deposit_uncharged"   // contract deal shipping/packaged with no deposit raised
  | "deposit_unpaid"      // deposit invoiced (or being collected) but money not in
  | "over_shipped"        // shipped more than owed
  | "needs_batch"         // no allocation yet
  | "amount_unrecorded";  // deposit paid, $ never written down

export interface Attention {
  kind: AttentionKind;
  /** 1 = most urgent. Ties inside a kind are broken by the caller (due date). */
  severity: number;
  label: string;
}

const SEVERITY: Record<AttentionKind, number> = {
  not_invoiced: 1,
  deposit_uncharged: 2,
  deposit_unpaid: 3,
  over_shipped: 4,
  needs_batch: 5,
  amount_unrecorded: 6,
};

const CLOSED = new Set(["fulfilled", "written_off", "cancelled"]);

export function commitmentAttention(c: LedgerCommitment): Attention[] {
  const out: Attention[] = [];
  const t = c.totals;
  const contract = c.channel === "contract_brewing";
  const closed = CLOSED.has(c.stage);

  if (t.uninvoiced_bbl > 0.005) {
    out.push({ kind: "not_invoiced", severity: SEVERITY.not_invoiced, label: `${t.uninvoiced_bbl.toFixed(2)} bbl shipped, not invoiced` });
  }
  if (contract && !closed) {
    const states = c.allocations.map((a) => a.deposit.state);
    if (states.some((s) => s === "uncharged") && (c.stage === "packaged" || c.stage === "shipping" || c.stage === "delivered" || c.stage === "brewing")) {
      out.push({ kind: "deposit_uncharged", severity: SEVERITY.deposit_uncharged, label: "deposit not charged" });
    } else if (states.some((s) => s === "pending_invoice" || s === "collecting")) {
      out.push({ kind: "deposit_unpaid", severity: SEVERITY.deposit_unpaid, label: "deposit awaiting payment" });
    }
  }
  // A closed deal's small overage was already absorbed when it closed.
  if (!closed && t.owed_bbl > 0 && t.shipped_bbl > t.owed_bbl + 0.01) {
    out.push({ kind: "over_shipped", severity: SEVERITY.over_shipped, label: `${(t.shipped_bbl - t.owed_bbl).toFixed(2)} bbl over` });
  }
  if (c.stage === "unplanned") {
    out.push({ kind: "needs_batch", severity: SEVERITY.needs_batch, label: "needs a batch" });
  }
  if (contract && c.allocations.some((a) => a.deposit.paid_at && a.deposit.paid_cents === 0 && a.deposit.collected_cents === 0)) {
    out.push({ kind: "amount_unrecorded", severity: SEVERITY.amount_unrecorded, label: "deposit amount not recorded" });
  }
  return out.sort((a, b) => a.severity - b.severity);
}

/** Sort key: most urgent flag first (the caller breaks ties on due date). 99 = nothing to do. */
export function attentionRank(c: LedgerCommitment): number {
  const a = commitmentAttention(c);
  return a.length ? a[0].severity : 99;
}
