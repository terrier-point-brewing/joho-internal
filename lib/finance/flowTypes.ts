/**
 * What a bank-ledger line IS, and therefore what the reports do with it.
 *
 * ── The question this answers, and the one it used to ask instead ────────────
 * A bookkeeper looking at a Chase line has to answer one thing: does this money
 * belong on the profit and loss, on the balance sheet, or nowhere because it is
 * already recorded somewhere else? The old six-value list asked a different
 * question — "which of these bank-transaction nouns is this?" — and left the
 * consequence invisible. Two of the nouns (`bill_settlement`, `card_settlement`)
 * and a third (`deposit`) all had the same consequence, `operating_expense` was
 * not offered at all, and `unclassified` is a workflow state rather than a kind
 * of transaction.
 *
 * So the values are GROUPED. The group heading states the consequence, the
 * option names the transaction, and every screen that renders a picker renders
 * both. A person picking "Card statement payment" can see, without knowing
 * anything about this codebase, that they are choosing "already recorded
 * elsewhere".
 *
 * ── Why the two booleans live here and not on the row ────────────────────────
 * `affectsPl` decides what the P&L and cash-flow readers count
 * (fetchSources filters `affects_pl = true`), and `needsAccount` decides whether
 * a chart-of-accounts picker is shown at all. Both are FUNCTIONS of the flow
 * type, never independent facts, and the bug this file exists to close came from
 * them drifting: `affectsPlForFlowType` returned true for interest income alone,
 * so an operator could pick an account on any other row and watch it silently
 * fail to reach a statement. Deriving both from one table means a new flow type
 * cannot be added without stating its consequence.
 *
 * `bank_ledger.affects_pl` remains a stored column because it is a query
 * predicate over up to two years of imported history — it is a cache of
 * `affectsPlForFlowType(flow_type)`, and every writer sets it from this registry.
 *
 * ── needsAccount, and why "no account" is enforced rather than suggested ─────
 * A row whose flow does not use an account must not CARRY one. The balance-sheet
 * reader (sumBank in balances/providers/transactionPostings.ts) matches on
 * `chart_of_accounts_id` and does not look at flow_type at all, so an account
 * left behind on a row someone reclassified to "internal transfer" would go on
 * quietly moving a reported balance. The API clears it on reclassification for
 * that reason; hiding the picker alone would not be enough.
 */

export type FlowType =
  | "operating_expense"
  | "other_income"
  | "balance_sheet_movement"
  | "card_settlement"
  | "bill_settlement"
  | "deposit"
  | "internal_transfer"
  | "unclassified";

/** The optgroup headings, in display order. Each states a consequence, not a category. */
export const FLOW_GROUPS = [
  "Counts on the P&L",
  "Moves the balance sheet",
  "Already recorded elsewhere",
  "Not a business transaction",
  "Needs review",
] as const;

export type FlowGroup = typeof FLOW_GROUPS[number];

export interface FlowTypeDef {
  /** Stored in `bank_ledger.flow_type` and `expense_counterparty_mappings.flow_type`. A published contract: renaming one silently reclassifies every row using it. */
  key: FlowType;
  group: FlowGroup;
  label: string;
  /**
   * What happens if you pick this, in a sentence an operator can act on. Shown
   * under the picker — it is the answer to "and then what?", which is the
   * question the old UI left a person to guess at.
   */
  effect: string;
  /** Whether a chart-of-accounts picker is shown, and whether an account may be stored at all. */
  needsAccount: boolean;
  /** Whether the P&L and cash-flow readers count this row. Cached onto `bank_ledger.affects_pl`. */
  affectsPl: boolean;
  /** How each flow reads mid-sentence, for setAsideReason(). */
  phrase: string;
}

export const FLOW_TYPES: FlowTypeDef[] = [
  {
    key: "operating_expense",
    group: "Counts on the P&L",
    label: "Operating expense",
    effect: "Counts as an expense on the P&L, under the account you choose.",
    needsAccount: true,
    affectsPl: true,
    phrase: "an operating expense",
  },
  {
    key: "other_income",
    group: "Counts on the P&L",
    label: "Income (interest, rebates, refunds)",
    effect: "Counts as income on the P&L, under the account you choose.",
    needsAccount: true,
    affectsPl: true,
    phrase: "income",
  },
  {
    key: "balance_sheet_movement",
    group: "Moves the balance sheet",
    label: "Balance sheet movement",
    effect: "Moves the account you choose — a loan, an owner contribution, a payment against an accrued liability. Never touches the P&L.",
    needsAccount: true,
    affectsPl: false,
    phrase: "a balance sheet movement",
  },
  {
    key: "card_settlement",
    group: "Already recorded elsewhere",
    label: "Card statement payment",
    effect: "Not counted. The card charges it pays off are already expenses.",
    needsAccount: false,
    affectsPl: false,
    phrase: "a card statement payment",
  },
  {
    key: "bill_settlement",
    group: "Already recorded elsewhere",
    label: "Bill payment",
    effect: "Not counted. The bill it pays off is already recorded.",
    needsAccount: false,
    affectsPl: false,
    phrase: "a bill settlement",
  },
  {
    key: "deposit",
    group: "Already recorded elsewhere",
    label: "Customer deposit / Square payout",
    effect: "Not counted. The sales it pays out are already recorded.",
    needsAccount: false,
    affectsPl: false,
    phrase: "a deposit",
  },
  {
    key: "internal_transfer",
    group: "Not a business transaction",
    label: "Internal transfer",
    effect: "Not counted. Money moving between accounts the business already owns is neither income nor expense.",
    needsAccount: false,
    affectsPl: false,
    phrase: "an internal transfer",
  },
  {
    key: "unclassified",
    group: "Needs review",
    label: "Unclassified — needs review",
    effect: "Not counted anywhere until someone says what it is.",
    needsAccount: false,
    affectsPl: false,
    phrase: "a bank flow, not an expense",
  },
];

const BY_KEY = new Map<string, FlowTypeDef>(FLOW_TYPES.map((f) => [f.key, f]));

export function getFlowType(key: string | null | undefined): FlowTypeDef | null {
  return key ? BY_KEY.get(key) ?? null : null;
}

/**
 * Whether an operator may store this value. Guards every PATCH body.
 *
 * An unknown key answers false: a value written by a newer deploy, or one
 * removed in a rollback, is rejected at the edge rather than stored and then
 * read by code that has no branch for it.
 */
export function isFlowType(key: string): key is FlowType {
  return BY_KEY.has(key);
}

/**
 * Whether this flow uses a chart-of-accounts account.
 *
 * An UNKNOWN key answers false, on purpose — the same reasoning as
 * codesFromRuleAccount in counterpartyHandlers.ts. "I do not recognise this
 * flow" must not mean "so keep whatever account was on the row".
 */
export function flowNeedsAccount(key: string | null | undefined): boolean {
  return getFlowType(key)?.needsAccount === true;
}

/** Whether the P&L and cash-flow readers count a row with this flow. Unknown ⇒ false. */
export function flowAffectsPl(key: string | null | undefined): boolean {
  return getFlowType(key)?.affectsPl === true;
}

/** The flow types in a group, for rendering one `<optgroup>`. */
export function flowTypesInGroup(group: FlowGroup): FlowTypeDef[] {
  return FLOW_TYPES.filter((f) => f.group === group);
}

// ── The settings picker's own vocabulary ─────────────────────────────────────
//
// The Counterparties screen asks "what is this money?" once, and its answer list
// is ALMOST the flow types — but not exactly, in two ways, and both matter
// enough that the list is built here rather than filtered ad hoc at the call
// site.
//
//   * `unclassified` is not offered. On a row it means "nobody has said yet";
//     as a standing RULE it would mean "always leave this for review", which is
//     the same as having no rule. The picker's empty option says that instead.
//
//   * `out_of_books` is offered but is NOT a flow type. It replaces the old
//     "In the books" toggle — a second control that had drifted to one user and
//     said, in a different vocabulary, what the flow list already says six ways.
//     It writes `bank_ledger_gl_rules.included = false`, never
//     `bank_ledger.flow_type`, and `isFlowType()` answers false for it so it
//     cannot be stored on a row by any path that checks.

/** The pseudo-answer that hides a counterparty's lines rather than classifying them. */
export const OUT_OF_BOOKS = "out_of_books";

/** The picker's group headings, in display order. */
export const TREATMENT_GROUPS = [
  "Counts on the P&L",
  "Moves the balance sheet",
  "Already recorded elsewhere",
  "Not a business transaction",
  "Hide entirely",
] as const;

export type TreatmentGroup = typeof TREATMENT_GROUPS[number];

export interface TreatmentOption {
  /** A FlowType, or OUT_OF_BOOKS. Never `unclassified` — the picker's empty option covers that. */
  value: string;
  group: TreatmentGroup;
  label: string;
  effect: string;
  /** Whether picking this makes the "account comes from" question relevant. */
  needsAccount: boolean;
}

const OUT_OF_BOOKS_OPTION: TreatmentOption = {
  value: OUT_OF_BOOKS,
  group: "Hide entirely",
  label: "Out of the books",
  effect: "Hidden from every report and from the bank ledger grid. For lines that are not the business's at all.",
  needsAccount: false,
};

export const TREATMENT_OPTIONS: TreatmentOption[] = [
  ...FLOW_TYPES
    .filter((f) => f.key !== "unclassified")
    .map(({ key, group, label, effect, needsAccount }) => ({
      value: key as string,
      // Safe because every non-`unclassified` flow group is also a treatment
      // group; the registry test asserts it rather than trusting it.
      group: group as TreatmentGroup,
      label,
      effect,
      needsAccount,
    })),
  OUT_OF_BOOKS_OPTION,
];

const TREATMENT_BY_VALUE = new Map(TREATMENT_OPTIONS.map((t) => [t.value, t]));

export function getTreatment(value: string | null | undefined): TreatmentOption | null {
  return value ? TREATMENT_BY_VALUE.get(value) ?? null : null;
}

/** The options in one group, for rendering an `<optgroup>`. */
export function treatmentsInGroup(group: TreatmentGroup): TreatmentOption[] {
  return TREATMENT_OPTIONS.filter((t) => t.group === group);
}

/**
 * Whether this answer makes the "account comes from" question relevant.
 *
 * An unrecognised value, and the empty "leave for review" answer, both say NO —
 * an account is only ever asked for once somebody has said what the money is.
 */
export function treatmentNeedsAccount(value: string | null | undefined): boolean {
  return getTreatment(value)?.needsAccount === true;
}
