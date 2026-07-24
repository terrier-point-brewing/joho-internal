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
