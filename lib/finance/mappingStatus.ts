// Shared chart-of-accounts mapping status logic for the Transactions tab
// (Orders / Invoices / Expenses). Pure — no IO, no React — so the same
// definition of "mapped / partial / unmapped" drives status pills and the
// mapping filter across all three subtabs.

export type MappingState = "empty" | "mapped" | "partial" | "unmapped" | "accepted";

/**
 * Classify a parent record by how many of its children are mapped to the CoA,
 * and whether the record has been manually accepted as not needing mapping.
 * A record that is fully mapped always reads as "mapped", even if it carries
 * a stale `accepted` flag from before it was completed.
 */
export function mappingState(mapped: number, total: number, accepted = false): MappingState {
  if (total === 0) return "empty";
  if (mapped >= total) return "mapped";
  if (accepted) return "accepted";
  if (mapped > 0) return "partial";
  return "unmapped";
}

export type MappingFilterValue = "all" | "mapped" | "partial" | "unmapped" | "accepted";

/** Does a record with `mapped`/`total` children (and `accepted` flag) satisfy the active filter? */
export function matchesMappingFilter(
  filter: MappingFilterValue,
  mapped: number,
  total: number,
  accepted = false,
): boolean {
  if (filter === "all") return true;
  const state = mappingState(mapped, total, accepted);
  // A record with no children only ever satisfies the "unmapped" bucket.
  if (state === "empty") return filter === "unmapped";
  return state === filter;
}
