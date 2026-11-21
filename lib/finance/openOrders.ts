// Which orders still have a line without an account -- across a whole date
// range, not one loaded page.
//
// The Orders tab pages server-side, so a mapping filter applied in the browser
// only ever sees the 50 orders on screen. That is fine for browsing and useless
// for the Financials tab's Unmapped flag, whose handful of order lines can sit
// months back: its link would open on a page that holds none of them. This
// picks the orders out up front so the page can be built from just those.

export interface OpenLineCandidate {
  orderId: string;
  transactionDate: string;
  /** The line's Square variation, when it has one. */
  variationId: string | null;
}

/**
 * Orders with at least one unresolved line, newest first.
 *
 * `lines` are the lines with no account of their own. One is still resolved
 * when its variation supplies an account or is marked excluded on GL Mapping --
 * the same "mapped or excluded" rule the Orders tab applies to each line --
 * so `resolvedVariationIds` carries exactly those variations.
 */
export function pickOpenOrderIds(lines: OpenLineCandidate[], resolvedVariationIds: ReadonlySet<string>): string[] {
  const dateByOrder = new Map<string, string>();
  for (const line of lines) {
    if (line.variationId && resolvedVariationIds.has(line.variationId)) continue;
    dateByOrder.set(line.orderId, line.transactionDate);
  }
  return [...dateByOrder.entries()]
    .sort(([idA, dateA], [idB, dateB]) => (dateA === dateB ? idA.localeCompare(idB) : dateA < dateB ? 1 : -1))
    .map(([id]) => id);
}
