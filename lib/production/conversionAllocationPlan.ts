/**
 * The allocation half of a conversion, decided explicitly.
 *
 * Converting part of a batch moves beer that allocations may already promise
 * to someone. Nothing here is allowed to happen silently: the operator defines
 * the allocations on the old batch and the new batch, and every consequence a
 * deposit invoice forces — a revision, a partial refund, a coverage transfer —
 * is computed up front, shown, and executed at submit.
 *
 * The rules, as agreed:
 *  - No invoice → a plain percentage update.
 *  - Generated/sent but UNPAID invoice → update + the invoice is re-generated
 *    (revised) to the new amount.
 *  - PAID invoice, entitlement leaving the partner → a partial refund at the
 *    proportion of the reduction, issued through the adjust flow.
 *  - PAID invoice, entitlement transferring to the child for the SAME
 *    commitment → NO refund; the paid deposit's coverage is recorded as
 *    spanning both batches (invoice_batch_links).
 *
 * Pure functions only — the modal renders these, the submit pipeline executes
 * them. Money math mirrors lib/finance/issueRefund exactly.
 */

export type InvoiceState = "none" | "generated" | "sent" | "paid";

export interface SourceAllocationInput {
  id: string;
  channel: string;
  partner_id: string | null;
  partner_name: string | null;
  contract_request_id: string | null;
  percentage: number;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
  deposit_amount_paid_cents: number | null;
  square_payment_id: string | null;
  written_off_at?: string | null;
}

export interface ChildAllocationDraft {
  /** Present when the row was seeded from (and mirrors) a source allocation. */
  source_allocation_id: string | null;
  channel: string;
  partner_id: string | null;
  partner_name: string | null;
  contract_request_id: string | null;
  percentage: number;
}

export function invoiceState(a: Pick<SourceAllocationInput, "invoice_generated_at" | "invoice_sent_at" | "invoice_paid_at">): InvoiceState {
  if (a.invoice_paid_at) return "paid";
  if (a.invoice_sent_at) return "sent";
  if (a.invoice_generated_at) return "generated";
  return "none";
}

/**
 * Default child allocations: the source's mix, verbatim. Same percentages on
 * the child's (smaller) volume means every partner's total bbl across the two
 * batches is exactly what it was before the conversion — the do-nothing-safe
 * default that triggers no invoice consequence at all. Written-off rows stay
 * behind: their claim was already settled.
 */
export function seedChildAllocations(source: SourceAllocationInput[]): ChildAllocationDraft[] {
  return source
    .filter((a) => !a.written_off_at)
    .map((a) => ({
      source_allocation_id: a.id,
      channel: a.channel,
      partner_id: a.partner_id,
      partner_name: a.partner_name,
      contract_request_id: a.contract_request_id,
      percentage: Number(a.percentage),
    }));
}

export type SourceConsequence =
  | { kind: "unchanged" }
  | { kind: "patch" }
  | { kind: "patch_and_revise" }
  | { kind: "refund"; refundCents: number }
  | { kind: "blocked_refund"; reason: string }
  | { kind: "blocked_increase"; reason: string };

/**
 * What saving `newPercentage` on this source allocation will do — the exact
 * contract of the endpoints that will be called, decided before submit.
 * Mirrors issueDepositReduction's rounding so the preview equals the refund.
 */
export function classifySourceEdit(a: SourceAllocationInput, newPercentage: number): SourceConsequence {
  const current = Number(a.percentage);
  if (newPercentage === current) return { kind: "unchanged" };

  const state = invoiceState(a);
  if (state === "paid") {
    if (newPercentage > current) {
      return { kind: "blocked_increase", reason: "A paid allocation cannot be increased — add a separate allocation instead." };
    }
    if (!a.square_payment_id || a.deposit_amount_paid_cents == null) {
      return {
        kind: "blocked_refund",
        reason: "No Square payment is on file for this paid allocation (paid before refund tracking) — handle the refund in the Square Dashboard first.",
      };
    }
    return {
      kind: "refund",
      refundCents: Math.round(Number(a.deposit_amount_paid_cents) * (1 - newPercentage / current)),
    };
  }
  if (state === "generated" || state === "sent") return { kind: "patch_and_revise" };
  return { kind: "patch" };
}

/**
 * The paid source allocations whose commitment also appears on the child —
 * the entitlement-follows case. No money moves; the paid deposit's coverage
 * is recorded as spanning both batches.
 */
export function coverageTransfers(
  source: SourceAllocationInput[],
  drafts: ChildAllocationDraft[],
): Array<{ sourceAllocationId: string; contractRequestId: string }> {
  const childCommitments = new Set(
    drafts.filter((d) => d.contract_request_id && d.percentage > 0).map((d) => d.contract_request_id as string),
  );
  return source
    .filter((a) =>
      invoiceState(a) === "paid"
      && a.contract_request_id
      && childCommitments.has(a.contract_request_id),
    )
    .map((a) => ({ sourceAllocationId: a.id, contractRequestId: a.contract_request_id as string }));
}

export interface PartnerTieRow {
  key: string;
  label: string;
  /** Estimated bbl before: source % × source booked volume. */
  beforeBbl: number;
  /** Estimated bbl after: edited source % × (source − converted) + child % × converted. */
  afterBbl: number;
  dropped: boolean;
}

const TIE_TOLERANCE_BBL = 0.01;

/**
 * Per-party before/after entitlement, estimated on booked volumes (final
 * entitlements settle on packaged volume, which nobody knows yet — this is
 * guidance, not bookkeeping). A party whose total drops is flagged; that is
 * the edit that arms a financial consequence, never a silent default.
 */
export function partnerTie(
  source: SourceAllocationInput[],
  edits: Record<string, number>,
  drafts: ChildAllocationDraft[],
  sourceVolumeBbl: number,
  convertVolumeBbl: number,
): PartnerTieRow[] {
  const remainderBbl = Math.max(0, sourceVolumeBbl - convertVolumeBbl);
  const rows = new Map<string, PartnerTieRow>();

  const keyOf = (channel: string, partnerId: string | null) => `${channel}:${partnerId ?? ""}`;
  const ensure = (channel: string, partnerId: string | null, partnerName: string | null) => {
    const key = keyOf(channel, partnerId);
    let row = rows.get(key);
    if (!row) {
      row = { key, label: partnerName ?? channel, beforeBbl: 0, afterBbl: 0, dropped: false };
      rows.set(key, row);
    }
    return row;
  };

  for (const a of source) {
    if (a.written_off_at) continue;
    const row = ensure(a.channel, a.partner_id, a.partner_name);
    const currentPct = Number(a.percentage);
    const editedPct = edits[a.id] ?? currentPct;
    row.beforeBbl += (currentPct / 100) * sourceVolumeBbl;
    row.afterBbl  += (editedPct / 100) * remainderBbl;
  }
  for (const d of drafts) {
    if (!(d.percentage > 0)) continue;
    const row = ensure(d.channel, d.partner_id, d.partner_name);
    row.afterBbl += (d.percentage / 100) * convertVolumeBbl;
  }

  for (const row of rows.values()) {
    row.beforeBbl = Math.round(row.beforeBbl * 1000) / 1000;
    row.afterBbl  = Math.round(row.afterBbl * 1000) / 1000;
    row.dropped   = row.afterBbl < row.beforeBbl - TIE_TOLERANCE_BBL;
  }
  return [...rows.values()].sort((x, y) => y.beforeBbl - x.beforeBbl);
}

export interface PlanValidation {
  blockers: string[];
  /** Refunds that will fire at submit, for the consent line. */
  refunds: Array<{ allocationId: string; partnerName: string | null; refundCents: number }>;
  revisions: string[];
  coverage: Array<{ sourceAllocationId: string; contractRequestId: string }>;
}

/** Everything the submit pipeline will do, or the reasons it must not run. */
export function validatePlan(
  source: SourceAllocationInput[],
  edits: Record<string, number>,
  drafts: ChildAllocationDraft[],
): PlanValidation {
  const blockers: string[] = [];
  const refunds: PlanValidation["refunds"] = [];
  const revisions: string[] = [];

  const childTotal = drafts.reduce((s, d) => s + Number(d.percentage || 0), 0);
  if (childTotal > 100.001) blockers.push(`Child allocations total ${childTotal.toFixed(1)}% — more than 100%.`);
  for (const d of drafts) {
    if (d.percentage < 0) blockers.push("A child allocation percentage is negative.");
  }

  for (const a of source) {
    const edited = edits[a.id];
    if (edited == null) continue;
    const consequence = classifySourceEdit(a, edited);
    if (consequence.kind === "blocked_refund" || consequence.kind === "blocked_increase") {
      blockers.push(`${a.partner_name ?? a.channel}: ${consequence.reason}`);
    } else if (consequence.kind === "refund") {
      refunds.push({ allocationId: a.id, partnerName: a.partner_name, refundCents: consequence.refundCents });
    } else if (consequence.kind === "patch_and_revise") {
      revisions.push(a.id);
    }
  }

  return { blockers, refunds, revisions, coverage: coverageTransfers(source, drafts) };
}
