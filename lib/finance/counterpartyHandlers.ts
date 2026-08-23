/**
 * Who codes a counterparty's bank lines — this screen, or something else.
 *
 * ── What "routing" was, and why it could not keep growing ────────────────────
 * `expense_counterparty_mappings.routing` started as a two-value enum
 * ('single_account' | 'payroll_split') pinned by a check constraint. That shape
 * charges six edits for every new mode — the constraint, three copies of the
 * union type, a branch in resolveExpenseMapping, and an `<option>` — and it
 * turns the Counterparties screen's dropdown into a menu of FEATURE NAMES that
 * an operator has to learn. Two was tolerable. The balance-sheet method layer
 * adds accounts continuously (see lib/finance/balances/methods/definitions.ts),
 * so the count only goes one way.
 *
 * The modes live here instead, as data. The check constraint is gone
 * (20260921090000) and this registry is the validator, exactly as
 * BUILT_IN_METHODS is the validator for a balance method's provider_key.
 *
 * ── Chosen vs claimed, which is the load-bearing distinction ─────────────────
 * A handler is one of two things, and the difference decides whether it appears
 * in the dropdown at all:
 *
 *   selectable  -- nothing upstream knows about this counterparty, so THIS
 *                  screen is genuinely where the decision gets made. Payroll is
 *                  the standing example: nothing in payroll settings names
 *                  Gusto, so somebody has to say so here.
 *
 *   claimed     -- the fact was already stated elsewhere and this screen only
 *                  reports it. Square is the standing example: GL 1040's method
 *                  already names the bank account Square pays into
 *                  (`sweepDestinationCoaId`), which IS the statement "Square
 *                  deposits on that feed are handled by this calculation".
 *                  Offering a "Square sweep" dropdown option would ask the
 *                  operator to say the same thing twice, in two screens, with
 *                  nothing keeping the two agreed — and a disagreement between
 *                  them is worse than either answer alone.
 *
 * Claims are resolved server-side in lib/finance/balances/counterpartyClaims.ts
 * and are never stored on the mapping row. Storing them would recreate the
 * second source of truth this exists to avoid: clearing the field on GL 1040
 * has to release the counterparty on its own, and it does, because there was
 * never a copy.
 */

/**
 * What the general ledger does with this counterparty's lines.
 *
 * Only "account" means "code it from the rule's chart_of_accounts_id". Every
 * other value means somebody else codes it, and resolveExpenseMapping leaves
 * the expense unmapped rather than guessing — which is what makes adding a
 * handler free at the resolver.
 */
export type CounterpartyGlEffect = "account" | "elsewhere";

export interface CounterpartyHandler {
  /** Stored in expense_counterparty_mappings.routing. A published contract: renaming one silently re-routes every counterparty already using it. */
  key: string;
  /**
   * The dropdown option, phrased as an answer to "where does the account come
   * from?" — which is the question this field has always answered. It used to be
   * labelled as if it answered "what kind of counterparty is this", which put it
   * in direct competition with the flow type and left an operator choosing
   * between two overlapping vocabularies.
   *
   * Selectable handlers only — a claimed one never reaches a menu.
   */
  label: string;
  /**
   * Shown in place of the chart-of-accounts picker.
   *
   * Claimed handlers override this with something that names the specific
   * account doing the work ("Handled by GL 1040 …"), because "handled by a
   * balance sheet calculation" tells an operator nothing they can act on.
   */
  badge: string;
  /** Where the decision actually gets made. Rendered as a "Manage →" link. */
  manageHref: string;
  glEffect: CounterpartyGlEffect;
  /** False for handlers that are only ever claimed — see the note at the top. */
  selectable: boolean;
}

/** The default. Every counterparty is this until something says otherwise. */
export const SINGLE_ACCOUNT = "single_account";

/** Claimed by a balance-sheet method that accounts for these lines itself. */
export const BALANCE_SHEET = "balance_sheet";

export const COUNTERPARTY_HANDLERS: CounterpartyHandler[] = [
  {
    key: SINGLE_ACCOUNT,
    label: "Chosen here",
    badge: "",
    manageHref: "",
    glEffect: "account",
    selectable: true,
  },
  {
    key: "payroll_split",
    label: "Split by payroll department",
    badge: "Split by GL account — matched per pay period",
    manageHref: "/settings/payroll/departments",
    glEffect: "elsewhere",
    selectable: true,
  },
  {
    key: BALANCE_SHEET,
    label: "A balance sheet calculation",
    // Replaced per row by the claim, which names the account. Kept non-empty so
    // a stored-but-unclaimed row (a method deleted after the fact) still renders
    // a sentence rather than an empty cell.
    badge: "Handled by a balance sheet calculation",
    manageHref: "/settings/finance/balance-sheet-accounts",
    glEffect: "elsewhere",
    selectable: false,
  },
];

const BY_KEY = new Map(COUNTERPARTY_HANDLERS.map((h) => [h.key, h]));

export function getCounterpartyHandler(key: string | null | undefined): CounterpartyHandler | null {
  return key ? BY_KEY.get(key) ?? null : null;
}

/** The dropdown's options, in declaration order. */
export const SELECTABLE_HANDLERS: CounterpartyHandler[] = COUNTERPARTY_HANDLERS.filter((h) => h.selectable);

/** Whether an operator may store this value on a mapping row. Guards the PATCH body. */
export function isSelectableHandler(key: string): boolean {
  return getCounterpartyHandler(key)?.selectable === true;
}

/**
 * Does this handler code the expense from the rule's own account?
 *
 * An UNKNOWN key answers false, on purpose. A routing value this build does not
 * recognise — a handler removed in a rollback, a row written by a newer deploy —
 * means "somebody else was supposed to handle this", and leaving the expense
 * unmapped surfaces it for a human. Answering true would code it to whatever
 * account happened to be sitting on the row.
 */
export function codesFromRuleAccount(key: string | null | undefined): boolean {
  return getCounterpartyHandler(key)?.glEffect === "account";
}
