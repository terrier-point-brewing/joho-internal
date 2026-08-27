/**
 * Dividing ONE bank line across several balance-sheet accounts.
 *
 * ── The transaction this exists for ──────────────────────────────────────────
 * A single wire buys a whole business. $400,625.00 leaves the operating account
 * on one line and arrives as brewery machinery, taproom fixtures, kegs and
 * leasehold improvements -- four accounts, one movement, and the split between
 * them is the asset purchase agreement's price allocation rather than anything
 * the bank knows. A bank row carries exactly one `chart_of_accounts_id`, so
 * before this the only ways to record it were to pick the biggest component and
 * misstate the other three, or to type the whole allocation as manual entries
 * and leave the actual bank line coded to nothing.
 *
 * ── Why only `balance_sheet_movement` ────────────────────────────────────────
 * Not caution -- the other seven flows genuinely have nowhere to put a split:
 *
 *   * `operating_expense` and `other_income` reach the P&L, and the P&L reads
 *     bank rows through fetchSources.fetchBank, which selects one account per
 *     row and has no split expansion. A split there would be accepted, stored,
 *     and silently ignored by the statement -- the exact failure
 *     manualCorrections.ts was written to end, and not one worth repeating.
 *     A card charge that needs splitting is an `expenses` row, which already
 *     has expense_gl_splits.
 *   * `card_settlement`, `bill_settlement`, `deposit` and `internal_transfer`
 *     use no account at all (flowTypes.ts), because what they move is recorded
 *     somewhere else. Splitting one across accounts it must not touch is not a
 *     finer answer, it is a double count with more decimal places.
 *   * `unclassified` has not been answered yet.
 *
 * So the rule is a property of the flow, checked here and re-checked in the
 * route, and the editor never renders for a row that cannot use it.
 *
 * ── Balance to the cent, same as an expense split ────────────────────────────
 * The balance-sheet reader REPLACES a split row's own account with its split
 * lines (sumBank/sumBankSplits in balances/providers/transactionPostings.ts)
 * rather than adding to it, exactly as the P&L does for a split expense. An
 * unbalanced split would therefore quietly restate an asset. The arithmetic is
 * shared with the expense editor rather than re-derived -- one implementation of
 * "do these lines add up" is one answer.
 */
import { splitRemainderCents, type ManualSplitLine } from "./expenseSplits";
import { BALANCE_SHEET_MOVEMENT } from "./flowTypes";

export type { ManualSplitLine };
export { splitRemainderCents, centsFromRaw, rawFromCents } from "./expenseSplits";

export type SplitValidation = { ok: true } | { ok: false; error: string };

/** One stored split line, as every reader here consumes it. */
export interface BankSplitLine {
  chartOfAccountsId: string;
  amountCents: number;
  memo?: string | null;
}

/**
 * Whether a row's flow permits a split at all. The editor's render condition,
 * the API's guard and the reclassification rule all ask this one function.
 */
export function flowAllowsSplit(flowType: string | null | undefined): boolean {
  return flowType === BALANCE_SHEET_MOVEMENT;
}

/**
 * The lines a bank row actually posts: its splits when it has any, otherwise the
 * single line implied by its own account and amount.
 *
 * Mirrors resolveExpenseGlLines, including the empty answer for a row with
 * neither -- an unclassified or uncoded line posts nothing, and inventing a
 * line for it would be inventing an account.
 */
export function resolveBankGlLines(
  splitRows: BankSplitLine[],
  fallback: { chartOfAccountsId: string | null; amountCents: number },
): BankSplitLine[] {
  if (splitRows.length > 0) return splitRows;
  if (!fallback.chartOfAccountsId) return [];
  return [{ chartOfAccountsId: fallback.chartOfAccountsId, amountCents: fallback.amountCents, memo: null }];
}

/**
 * Every rule a stored split must satisfy. Called by the editor to decide whether
 * Save is live, and again by the route before anything is written -- a client
 * that skipped the first is not trusted by the second.
 */
export function validateBankSplit(
  lines: ManualSplitLine[],
  parentAmountCents: number,
  flowType: string | null | undefined,
): SplitValidation {
  if (!flowAllowsSplit(flowType)) {
    return { ok: false, error: "Only a balance sheet movement can be split across accounts" };
  }
  if (parentAmountCents === 0) return { ok: false, error: "Cannot split a zero-amount line" };
  if (lines.length < 2) return { ok: false, error: "A split needs at least 2 lines" };

  const parentSign = Math.sign(parentAmountCents);
  for (const l of lines) {
    if (!l.chartOfAccountsId) return { ok: false, error: "Every split line needs a GL account" };
    if (!Number.isInteger(l.amountCents)) return { ok: false, error: "Split amounts must be whole cents" };
    if (l.amountCents === 0) return { ok: false, error: "Split lines cannot be zero" };
    // One line running against the others would be a transfer BETWEEN two
    // balance-sheet accounts dressed up as an allocation of this movement, and
    // the pair would net to less than the money that actually left the bank.
    if (Math.sign(l.amountCents) !== parentSign) {
      return { ok: false, error: "Split lines must run the same direction as the bank line" };
    }
  }
  // Duplicate accounts are two answers to one question. Allowed on an expense
  // split, where a payroll run legitimately posts twice to one account; here it
  // is a typist adding a line instead of editing one, and merging them silently
  // would hide the mistake.
  const accounts = new Set(lines.map((l) => l.chartOfAccountsId));
  if (accounts.size !== lines.length) {
    return { ok: false, error: "Each split line needs a different GL account" };
  }

  const remainder = splitRemainderCents(lines, parentAmountCents);
  if (remainder !== 0) return { ok: false, error: `Split lines are off by ${remainder} cents` };
  return { ok: true };
}
