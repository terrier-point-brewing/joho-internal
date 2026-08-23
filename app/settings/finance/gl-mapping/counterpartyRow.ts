/**
 * What one counterparty row shows, decided once.
 *
 * The panel asks two questions in order — "what is this money?" then "where does
 * the account come from?" — and each cell renders only when the previous answer
 * makes it relevant. The same predicates also drive the summary line above the
 * table.
 *
 * Both live here, in one pure function, because they were separate before and
 * the drift was invisible: the summary could count a counterparty as needing an
 * account while the row showed no picker for it, and nothing would fail. A
 * screen that says "3 of 7 mapped" over a table with four account pickers is
 * worse than one that says nothing.
 */
import { feedClassifiesOwnLines } from "./bankFeeds";
import { OUT_OF_BOOKS, getTreatment, treatmentNeedsAccount } from "@/lib/finance/flowTypes";

/** The parts of a counterparty rule this decision reads. */
export interface RowFacts {
  source: string;
  counterparty_key: string;
  /** Null = no opinion; the operator has not answered step 1. */
  flow_type: string | null;
  /** Whether something else already accounts for this counterparty. */
  handledElsewhere: boolean;
}

/** The standing include/exclude rules, as the panel already holds them. */
export interface InclusionState {
  /** Feed → included. Absent means no rule, which means included. */
  feeds: Map<string, boolean>;
  /** "source key" → included. Absent means no rule, which means included. */
  counterparties: Map<string, boolean>;
}

export interface RowState {
  /** The whole bank feed is switched off, so nothing about this row applies. */
  feedOff: boolean;
  /** This feed's importer classifies each line, so step 1 is not asked. */
  selfClassifying: boolean;
  /** Step 1's current answer: a flow type, OUT_OF_BOOKS, or "" for none yet. */
  treatment: string;
  /** Whether steps 2 and 3 are asked at all. */
  asksAccountSource: boolean;
  /** Which summary bucket this row falls in. Exactly one. */
  bucket: "feed-off" | "excluded" | "handled-elsewhere" | "needs-account" | "no-account-needed" | "awaiting-decision";
}

export function rowKeyOf(r: { source: string; counterparty_key: string }): string {
  return `${r.source} ${r.counterparty_key}`;
}

export function counterpartyRowState(rule: RowFacts, inclusion: InclusionState): RowState {
  const feedOff = inclusion.feeds.get(rule.source) === false;
  const excluded = inclusion.counterparties.get(rowKeyOf(rule)) === false;
  const selfClassifying = feedClassifiesOwnLines(rule.source);

  // `out_of_books` is not stored on the rule — it lives in bank_ledger_gl_rules
  // — so it is folded in here. One control, whichever table the answer lands in;
  // which table is an implementation fact and was never the operator's problem.
  const treatment = excluded ? OUT_OF_BOOKS : (rule.flow_type ?? "");

  // A self-classifying feed always asks for the account: its `expenses` rows are
  // operating expenses by construction, because the importer diverts them there.
  // So the account is live even though step 1 was never put to the operator.
  const asksAccountSource = !feedOff && !excluded
    && (selfClassifying || treatmentNeedsAccount(treatment));

  // An unanswered step 1 outranks a claim, and the order is the point.
  //
  // A claim says who owns the ACCOUNT. It says nothing about what the money is,
  // so a claimed counterparty with no answer to step 1 is still waiting on a
  // person. Ranking the claim first counted Square as finished while its own row
  // read "answer step 1 first" — and Square's four Chase payouts sitting
  // unclassified is the exact failure this screen was rebuilt to surface.
  //
  // A self-classifying feed is never "awaiting": step 1 was answered at import.
  const awaitingStepOne = !selfClassifying && treatment === "";

  const bucket: RowState["bucket"] =
      feedOff                        ? "feed-off"
    : excluded                       ? "excluded"
    : awaitingStepOne                ? "awaiting-decision"
    : rule.handledElsewhere          ? "handled-elsewhere"
    : asksAccountSource              ? "needs-account"
    :                                  "no-account-needed";

  return { feedOff, selfClassifying, treatment, asksAccountSource, bucket };
}
