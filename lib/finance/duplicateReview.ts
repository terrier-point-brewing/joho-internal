/**
 * The possible-duplicates review: read the feeds, run the matcher, and keep
 * what a person decided about each pair.
 *
 * duplicateCandidates.ts is the pure half and proposes pairs. This is the half
 * that touches the database: it loads the rows, subtracts the pairs already
 * answered (`duplicate_candidate_reviews`), and carries out an answer.
 *
 * ── Nothing here acts on its own ─────────────────────────────────────────────
 * Every write is one person's answer to one pair. "Set it aside" uses the
 * mechanisms that already exist -- `expenses.excluded_at`, and
 * `bank_ledger.flow_type = 'bill_settlement'` -- rather than a third way of
 * removing money from a statement.
 *
 * ── Closed months ────────────────────────────────────────────────────────────
 * Setting a record aside changes the figures of the month it is dated in, so it
 * is refused once that month is closed. The duplicate is still real; it gets
 * the answer "corrected elsewhere" with a note, which is how the September 2026
 * finds were handled (manual entries dated in the open month).
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { affectsPlForFlowType } from "@/lib/finance/bankLedger";
import { excludeExpense } from "@/lib/finance/expenseExclusion";
import { readPeriodClose } from "@/lib/finance/balances/periodCloseState";
import { formatPeriodLabel } from "@/lib/finance/balances/periods";
import {
  findDuplicateCandidates,
  type DuplicateCandidate,
  type DuplicateInputs,
} from "./duplicateCandidates";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type DuplicateResolution = "not_duplicate" | "duplicate_set_aside" | "duplicate_corrected";

export function isDuplicateResolution(value: unknown): value is DuplicateResolution {
  return value === "not_duplicate" || value === "duplicate_set_aside" || value === "duplicate_corrected";
}

export interface PendingDuplicate extends DuplicateCandidate {
  /** The month the duplicate sits in has been closed. */
  periodClosed: boolean;
  /** Null when "set it aside" is available; otherwise the sentence saying why not. */
  setAsideBlocked: string | null;
}

export interface ReviewedDuplicate {
  candidate: DuplicateCandidate;
  resolution: DuplicateResolution;
  note: string | null;
  reviewedAt: string;
  reviewedByEmail: string | null;
}

export interface DuplicateReviewList {
  pending: PendingDuplicate[];
  reviewed: ReviewedDuplicate[];
}

interface ReviewRow {
  candidate_key: string;
  resolution: DuplicateResolution;
  note: string | null;
  snapshot: DuplicateCandidate;
  reviewed_by: string | null;
  reviewed_at: string;
}

/** "relation does not exist" — the code can be deployed before the migration is applied. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01" || error.code === "PGRST205" || /duplicate_candidate_reviews/.test(error.message ?? "");
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function loadDuplicateInputs(supabase: AdminClient): Promise<DuplicateInputs> {
  const [expenseRows, bankRows, manualRows] = await Promise.all([
    fetchAllRows<{
      id: string;
      source_transaction_id: string;
      ramp_object: string | null;
      merchant_name: string | null;
      accounting_date: string | null;
      settled_at: string | null;
      amount_cents: number | null;
      state: string | null;
      excluded_at: string | null;
    }>(() =>
      supabase
        .from("expenses")
        .select("id, source_transaction_id, ramp_object, merchant_name, accounting_date, settled_at, amount_cents, state, excluded_at")
        .in("ramp_object", ["bill", "card", "bank"])
        .order("id", { ascending: true }),
    ),
    // Every bank line, whatever its feed's GL switch says: a Chase line that is
    // not on the books today is exactly the one that doubles a bill the day it
    // is switched on or coded.
    fetchAllRows<{
      id: string;
      source: string;
      counterparty_name: string | null;
      description: string | null;
      transaction_date: string;
      amount_cents: number | null;
      flow_type: string | null;
    }>(() =>
      supabase
        .from("bank_ledger")
        .select("id, source, counterparty_name, description, transaction_date, amount_cents, flow_type")
        .order("id", { ascending: true }),
    ),
    fetchAllRows<{ id: string; label: string | null; start_date: string; end_date: string; amount_cents: number | null }>(() =>
      supabase
        .from("manual_entries")
        .select("id, label, start_date, end_date, amount_cents")
        .eq("entry_kind", "flow")
        .order("id", { ascending: true }),
    ),
  ]);

  const inputs: DuplicateInputs = { billLines: [], expenses: [], bankLines: [], manualFlows: [] };
  for (const r of expenseRows) {
    if (r.ramp_object === "bill") {
      // An undated bill line cannot be placed in a window; there are none, and
      // one that appears is the sync's problem rather than a duplicate.
      if (!r.accounting_date) continue;
      inputs.billLines.push({
        id: r.id,
        sourceTransactionId: r.source_transaction_id,
        merchantName: r.merchant_name,
        accountingDate: r.accounting_date,
        settledAt: r.settled_at,
        amountCents: r.amount_cents ?? 0,
        excluded: r.excluded_at !== null,
      });
    } else if (r.ramp_object === "card" || r.ramp_object === "bank") {
      inputs.expenses.push({
        id: r.id,
        rampObject: r.ramp_object,
        merchantName: r.merchant_name,
        accountingDate: r.accounting_date,
        amountCents: r.amount_cents ?? 0,
        state: r.state,
        excluded: r.excluded_at !== null,
      });
    }
  }
  for (const r of bankRows) {
    inputs.bankLines.push({
      id: r.id,
      source: r.source,
      name: r.counterparty_name ?? r.description,
      transactionDate: r.transaction_date,
      amountCents: r.amount_cents ?? 0,
      flowType: r.flow_type,
    });
  }
  for (const r of manualRows) {
    inputs.manualFlows.push({
      id: r.id,
      label: r.label,
      startDate: r.start_date,
      endDate: r.end_date,
      amountCents: r.amount_cents ?? 0,
    });
  }
  return inputs;
}

async function loadReviews(supabase: AdminClient): Promise<ReviewRow[]> {
  const { data, error } = await supabase
    .from("duplicate_candidate_reviews")
    .select("candidate_key, resolution, note, snapshot, reviewed_by, reviewed_at")
    .order("reviewed_at", { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as ReviewRow[];
}

/** Pairs the matcher proposes that nobody has answered yet. */
async function loadUnreviewed(supabase: AdminClient): Promise<{ unreviewed: DuplicateCandidate[]; reviews: ReviewRow[] }> {
  const [inputs, reviews] = await Promise.all([loadDuplicateInputs(supabase), loadReviews(supabase)]);
  const answered = new Set(reviews.map((r) => r.candidate_key));
  return { unreviewed: findDuplicateCandidates(inputs).filter((c) => !answered.has(c.key)), reviews };
}

async function closedPeriods(supabase: AdminClient, periodEnds: string[]): Promise<Set<string>> {
  const distinct = Array.from(new Set(periodEnds));
  const states = await Promise.all(distinct.map((p) => readPeriodClose(supabase, p)));
  return new Set(distinct.filter((_, i) => states[i]?.closed));
}

/** Pure. Why this pair cannot be set aside from the review, or null when it can. */
export function setAsideBlocker(candidate: DuplicateCandidate, periodClosed: boolean): string | null {
  if (candidate.duplicate.table === "manual_entries") {
    return "A manual entry is edited or deleted on the Manual Entries tab. Once it is fixed there, record that here.";
  }
  if (periodClosed) {
    return (
      `${formatPeriodLabel(candidate.periodEnd)} is closed, so its figures no longer change. ` +
      `Correct this with a manual entry in an open month, then record that here.`
    );
  }
  return null;
}

export async function listDuplicateReview(supabase: AdminClient): Promise<DuplicateReviewList> {
  const { unreviewed, reviews } = await loadUnreviewed(supabase);
  const closed = await closedPeriods(supabase, unreviewed.map((c) => c.periodEnd));

  const reviewerIds = Array.from(new Set(reviews.map((r) => r.reviewed_by).filter((v): v is string => !!v)));
  const emailById = new Map<string, string>();
  if (reviewerIds.length > 0) {
    const { data, error } = await supabase.from("profiles").select("id, email").in("id", reviewerIds);
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as { id: string; email: string | null }[]) {
      if (p.email) emailById.set(p.id, p.email);
    }
  }

  return {
    pending: unreviewed.map((c) => {
      const periodClosed = closed.has(c.periodEnd);
      return { ...c, periodClosed, setAsideBlocked: setAsideBlocker(c, periodClosed) };
    }),
    reviewed: reviews.map((r) => ({
      candidate: r.snapshot,
      resolution: r.resolution,
      note: r.note,
      reviewedAt: r.reviewed_at,
      reviewedByEmail: r.reviewed_by ? emailById.get(r.reviewed_by) ?? null : null,
    })),
  };
}

/**
 * How many unanswered pairs a close of `periodEnd` would be signing over.
 *
 * Everything dated in that month OR EARLIER: a pair left unanswered in June is
 * still unanswered in October, and each month closed over it is one more month
 * of statements carrying a figure nobody has confirmed.
 */
export async function countUnreviewedDuplicates(supabase: AdminClient, periodEnd: string): Promise<number> {
  const { unreviewed } = await loadUnreviewed(supabase);
  return unreviewed.filter((c) => c.periodEnd <= periodEnd).length;
}

// ── writes ──────────────────────────────────────────────────────────────────

export type ResolveResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/**
 * Record one answer, carrying out "set it aside" first when that is the answer.
 *
 * The pair is looked up by key in a FRESH run of the matcher rather than
 * trusted from the request, so this can only ever set aside a record the
 * matcher is proposing right now -- not an arbitrary id a client sends.
 */
export async function resolveDuplicate(
  supabase: AdminClient,
  input: { key: string; resolution: DuplicateResolution; note: string | null; userId: string | null },
): Promise<ResolveResult> {
  const note = input.note?.trim() || null;
  if (input.resolution === "duplicate_corrected" && !note) {
    return { ok: false, status: 400, error: "Say how this duplicate was corrected — for example, which manual entry reverses it." };
  }

  const { unreviewed } = await loadUnreviewed(supabase);
  const candidate = unreviewed.find((c) => c.key === input.key);
  if (!candidate) {
    return { ok: false, status: 404, error: "That pair is no longer waiting for review — it may already have been answered." };
  }

  if (input.resolution === "duplicate_set_aside") {
    const closed = await closedPeriods(supabase, [candidate.periodEnd]);
    const blocked = setAsideBlocker(candidate, closed.has(candidate.periodEnd));
    if (blocked) return { ok: false, status: 409, error: blocked };

    const [matched] = candidate.matched;
    const reason = note ?? `Duplicate of the ${matched.name} bill of ${matched.date}`;
    const id = candidate.duplicate.ids[0];

    if (candidate.duplicate.table === "expenses") {
      const excluded = await excludeExpense(supabase, { id, reason, userId: input.userId });
      if (!excluded.ok) return excluded;
    } else {
      // The bank line becomes what it is: a bill being paid. Mirrors the Bank
      // Ledger grid's own reclassification (app/api/finance/bank-ledger PATCH):
      // a flow that takes no account loses its account and any allocation, the
      // allocation first so a failure cannot orphan it under the new flow.
      const { error: splitErr } = await supabase.from("bank_ledger_gl_splits").delete().eq("bank_ledger_id", id);
      if (splitErr) return { ok: false, status: 500, error: splitErr.message };
      const { error } = await supabase
        .from("bank_ledger")
        .update({
          flow_type: "bill_settlement",
          affects_pl: affectsPlForFlowType("bill_settlement"),
          mapping_source: "manual",
          chart_of_accounts_id: null,
        })
        .eq("id", id);
      if (error) return { ok: false, status: 500, error: error.message };
    }
  }

  const { error } = await supabase.from("duplicate_candidate_reviews").insert({
    candidate_key: candidate.key,
    kind: candidate.kind,
    resolution: input.resolution,
    note,
    period_end: candidate.periodEnd,
    snapshot: candidate,
    reviewed_by: input.userId,
  });
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true };
}

/**
 * Take an answer back, so the pair is asked about again.
 *
 * Not offered for a set-aside: deleting that record would not bring the
 * expense back, and a review list that says "undone" over a row still excluded
 * is worse than no undo. Restoring an excluded expense is the Expenses tab's
 * job, where the exclusion is visible.
 */
export async function reopenDuplicateReview(supabase: AdminClient, key: string): Promise<ResolveResult> {
  const { data, error } = await supabase
    .from("duplicate_candidate_reviews")
    .delete()
    .eq("candidate_key", key)
    .neq("resolution", "duplicate_set_aside")
    .select("candidate_key");
  if (error) return { ok: false, status: 500, error: error.message };
  if ((data ?? []).length === 0) {
    return { ok: false, status: 409, error: "That answer cannot be taken back here." };
  }
  return { ok: true };
}
