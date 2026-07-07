// Shared chart-of-accounts mapping status logic for the Transactions tab
// (Orders / Invoices / Expenses). Pure — no IO, no React — so the same
// definition of "mapped / partial / unmapped" drives status pills and the
// mapping filter across all three subtabs.

export type MappingState = "empty" | "mapped" | "partial" | "unmapped";

/** Classify a parent record by how many of its children are mapped to the CoA. */
export function mappingState(mapped: number, total: number): MappingState {
  if (total === 0) return "empty";
  if (mapped >= total) return "mapped";
  if (mapped > 0) return "partial";
  return "unmapped";
}

export type MappingFilterValue = "all" | "mapped" | "partial" | "unmapped";

/** Does a record with `mapped`/`total` children satisfy the active filter? */
export function matchesMappingFilter(
  filter: MappingFilterValue,
  mapped: number,
  total: number,
): boolean {
  if (filter === "all") return true;
  const state = mappingState(mapped, total);
  // A record with no children only ever satisfies the "unmapped" bucket.
  if (state === "empty") return filter === "unmapped";
  return state === filter;
}
