// What the API sends, as opposed to what buildFinancials computes.
//
// The two differ in exactly one way: `sourceRef.ids`. The aggregation layer
// records every source row id behind a figure, which is real provenance and
// worth keeping -- aggregateRows.ts's tests assert on it, and the parity
// harness (scripts/financials-parity.ts) reads whole responses. It just has no
// business crossing the network. On the P&L it was 218 KB of a 295 KB payload,
// 5,732 UUIDs with 3,589 on one row, serialized, gzipped, parsed and then
// re-walked by buildTree on every filter change -- and never rendered.
//
// Stripped here rather than never built: the ids are the answer to "which rows
// is this figure made of", which is a question a drill-through will ask
// server-side. Dropping them from the wire costs that nothing; dropping them
// from the model would.

import type { FinancialsResponse } from "./types";

/**
 * `response` with every row's `sourceRef.ids` removed. `sourceRef.table`
 * survives -- manualAdjustment.ts discriminates a manual entry on it, so
 * dropping the whole field would silently un-italicize every manual adjustment
 * line on the statement.
 *
 * Pure, and does not mutate `response`.
 */
export function toWireResponse(response: FinancialsResponse): FinancialsResponse {
  return {
    ...response,
    rows: response.rows.map((row) => ({ ...row, sourceRef: { table: row.sourceRef.table } })),
  };
}
