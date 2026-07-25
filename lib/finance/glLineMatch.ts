/**
 * Shared GL-account filtering for the Transactions ledgers.
 *
 * The four subtabs hold their GL coding at different grains -- one account on
 * the row (Bank Ledger), or one per line item / split (Orders, Invoices,
 * Expenses) -- so both the "does this row match" predicate and the "which lines
 * survive" narrowing live here rather than being re-derived per page.
 *
 * An empty selection means "no filter applied", not "match nothing": that is
 * the state every page is in until the operator picks an account, and it must
 * leave the ledger exactly as it renders today.
 */

/** True when any of `lineCoaIds` is in `selected`. Unmapped (null) lines never match. */
export function matchesGlFilter(lineCoaIds: (string | null | undefined)[], selected: string[]): boolean {
  if (selected.length === 0) return true;
  return lineCoaIds.some((id) => !!id && selected.includes(id));
}

/** The lines whose GL account is in `selected`, in input order. Returns every line when nothing is selected. */
export function narrowToGl<T>(
  lines: T[],
  coaIdOf: (line: T) => string | null | undefined,
  selected: string[],
): T[] {
  if (selected.length === 0) return lines;
  return lines.filter((line) => {
    const id = coaIdOf(line);
    return !!id && selected.includes(id);
  });
}
