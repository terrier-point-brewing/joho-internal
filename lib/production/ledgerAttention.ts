import type { LedgerCommitment } from "./partnerLedger";

/**
 * What a commitment needs from a human, ranked, plus the warnings that say
 * how a closed deal closed.
 *
 * The ledger exists to show what was committed, whether it was fulfilled,
 * and whether it was charged correctly. So the flags are money first, then
 * the two things that stop a deal moving, then the closing notes. Closing
 * notes are not actions: a closed deal that over- or under-delivered is
 * shown as such, but it does not need anyone's attention.
 */
export type AttentionKind =
  | "not_invoiced"        // beer left, no export invoice
  | "deposit_uncharged"   // contract deal has beer packaged or shipped and no deposit raised
  | "deposit_unpaid"      // deposit invoiced (or being collected) but money not in
  | "needs_batch"         // no allocation yet
  | "over_delivered"      // shipped more than owed — bill it while open; a note once closed
  | "amount_unrecorded"   // deposit paid, $ never written down
  | "under_delivered";    // closed short: the remainder was written off

export interface Attention {
  kind: AttentionKind;
  /** 1 = most urgent. Ties inside a kind are broken by the caller (due date). */
  severity: number;
  label: string;
  /** False for closing notes: shown on the row, never counted as "needs attention". */
  actionable: boolean;
}

const SEVERITY: Record<AttentionKind, number> = {
  not_invoiced: 1,
  deposit_uncharged: 2,
  deposit_unpaid: 3,
  needs_batch: 4,
  over_delivered: 5,
  amount_unrecorded: 6,
  under_delivered: 7,
};

export function commitmentAttention(c: LedgerCommitment): Attention[] {
  const out: Attention[] = [];
  const t = c.totals;
  const contract = c.channel === "contract_brewing";
  const open = c.stage === "open";
  const closed = c.stage === "closed";
  const push = (kind: AttentionKind, label: string, actionable = true) =>
    out.push({ kind, severity: SEVERITY[kind], label, actionable });

  if (t.uninvoiced_bbl > 0.005) {
    push("not_invoiced", `${t.uninvoiced_bbl.toFixed(2)} bbl shipped, not invoiced`);
  }
  if (contract && c.stage !== "cancelled") {
    const states = c.allocations.map((a) => a.deposit.state);
    const beerExists = c.allocations.some((a) => a.produced_bbl > 0 || a.exported_bbl > 0);
    if (beerExists && states.some((s) => s === "uncharged")) {
      push("deposit_uncharged", "deposit not charged");
    } else if (states.some((s) => s === "pending_invoice" || s === "collecting")) {
      push("deposit_unpaid", "deposit awaiting payment");
    }
  }
  if (open && c.allocations.length === 0) {
    push("needs_batch", "needs a batch");
  }
  if (t.owed_bbl > 0 && t.shipped_bbl > t.owed_bbl + 0.01) {
    push("over_delivered", `${(t.shipped_bbl - t.owed_bbl).toFixed(2)} bbl over`, open);
  }
  if (closed) {
    const short = c.allocations
      .filter((a) => a.written_off_bbl != null)
      .reduce((s, a) => s + Math.max(0, a.owed_bbl - a.exported_bbl), 0);
    if (short > 0.01) push("under_delivered", `${short.toFixed(2)} bbl short, written off`, false);
  }
  if (contract && c.allocations.some((a) => a.deposit.paid_at && a.deposit.paid_cents === 0 && a.deposit.collected_cents === 0)) {
    push("amount_unrecorded", "deposit amount not recorded");
  }
  return out.sort((a, b) => a.severity - b.severity);
}

/** Sort key: most urgent ACTIONABLE flag first (caller breaks ties on due date). 99 = nothing to do. */
export function attentionRank(c: LedgerCommitment): number {
  const a = commitmentAttention(c).filter((f) => f.actionable);
  return a.length ? a[0].severity : 99;
}
