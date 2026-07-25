/**
 * Pure validation for manual GL splits on an expense.
 *
 * The P&L aggregation REPLACES a split expense's own account/amount with its
 * split lines (aggregateRows.ts:305-312) rather than merging them, so an
 * unbalanced split silently changes the reported expense total. Exact-cents
 * balance is therefore a hard invariant, enforced here and re-checked
 * server-side before any write.
 *
 * Amounts are signed to match the parent's cash direction (outflow negative),
 * matching how payroll splits are stored (payrollMatching.ts:213-231).
 */

export interface ManualSplitLine {
  chartOfAccountsId: string;
  amountCents: number;
  memo?: string | null;
}

export type SplitValidation = { ok: true } | { ok: false; error: string };

/**
 * Cents from a raw money string as typed into an input. Partial or non-numeric
 * input ("", "-", "1.", "1.2.3") yields 0, never NaN — an NaN would propagate
 * silently through validation and into the request body.
 *
 * Lives here rather than in the split editor because a field bound to a
 * re-formatted number swallows keystrokes: from "0.00" with the caret at the
 * end, typing "1" yields "0.001", which rounds back to 0 cents and re-renders
 * as "0.00". The editor keeps the raw string and calls this; that split of
 * responsibilities is what makes the parsing testable.
 */
export function centsFromRaw(raw: string): number {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Canonical two-decimal display for a cents value. For seeding a field and normalizing on blur — never mid-typing. */
export function rawFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Cents still unallocated: parent minus the sum of the supplied lines. Zero means balanced. */
export function splitRemainderCents(lines: { amountCents: number }[], parentAmountCents: number): number {
  return parentAmountCents - lines.reduce((total, l) => total + l.amountCents, 0);
}

export function validateManualSplit(lines: ManualSplitLine[], parentAmountCents: number): SplitValidation {
  if (parentAmountCents === 0) return { ok: false, error: "Cannot split a zero-amount expense" };
  if (lines.length < 2) return { ok: false, error: "A split needs at least 2 lines" };

  const parentSign = Math.sign(parentAmountCents);
  for (const l of lines) {
    if (!l.chartOfAccountsId) return { ok: false, error: "Every split line needs a GL account" };
    if (!Number.isInteger(l.amountCents)) return { ok: false, error: "Split amounts must be whole cents" };
    if (l.amountCents === 0) return { ok: false, error: "Split lines cannot be zero" };
    if (Math.sign(l.amountCents) !== parentSign) {
      return { ok: false, error: "Split lines must run the same direction as the expense" };
    }
  }

  const remainder = splitRemainderCents(lines, parentAmountCents);
  if (remainder !== 0) {
    return { ok: false, error: `Split lines are off by ${remainder} cents` };
  }
  return { ok: true };
}
