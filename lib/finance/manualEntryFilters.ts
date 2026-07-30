// Parses and describes the `kind`/`year` query params for
// GET /api/finance/manual-entries into a filter the route applies to the
// Supabase query builder. Pure logic (no Supabase import) so it can be unit
// -tested directly — see lib/finance/manualEntryFilters.test.ts. Mirrors the
// shape of lib/finance/financials/parseParams.ts for the neighboring route.

import type { ManualEntryKind } from "./manualEntries";

export type ManualEntryFilter =
  | { type: "none" }
  | { type: "kind"; kind: ManualEntryKind }
  | { type: "kind-year"; kind: "flow"; yearStart: string; yearEnd: string }
  | { type: "kind-year"; kind: "balance"; yearStart: string; yearEnd: string }
  | { type: "year"; yearStart: string; yearEnd: string; or: string };

/**
 * Parses `kind` and `year` query params into a description of the filter to
 * apply. `kind` is validated (an unrecognized value is treated as absent).
 *
 * `year` is DELIBERATELY not validated the way `parseFinancialsParams`
 * validates its (required) year: this `year` is an optional refinement of an
 * otherwise-valid list request, so an unparseable value is silently treated
 * as "no year filter" rather than 400ing the whole request.
 */
export function parseManualEntryFilter(
  kindParam: string | null,
  yearParam: string | null,
): ManualEntryFilter {
  const kind = kindParam === "flow" || kindParam === "balance" ? kindParam : null;

  // The range bound is load-bearing, not decorative. `Number("")` is 0, which
  // Number.isInteger accepts, so a bare `?year=` would otherwise build
  // "0-01-01" and hand Postgres a value it rejects with 22008 -- a 500 out of
  // what is supposed to be a silently-ignored optional filter. Same 2000-2100
  // window parseFinancialsParams uses.
  const yearNum = yearParam !== null ? Number(yearParam) : NaN;
  const year =
    Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100 ? yearNum : null;

  if (year === null) {
    return kind ? { type: "kind", kind } : { type: "none" };
  }

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  if (kind === "flow" || kind === "balance") {
    return { type: "kind-year", kind, yearStart, yearEnd };
  }

  // No kind filter: match either a flow entry overlapping the year, or a
  // balance entry dated within it.
  return {
    type: "year",
    yearStart,
    yearEnd,
    or:
      `and(entry_kind.eq.flow,start_date.lte.${yearEnd},end_date.gte.${yearStart}),` +
      `and(entry_kind.eq.balance,as_of_date.gte.${yearStart},as_of_date.lte.${yearEnd})`,
  };
}

/** Row shape a filter is matched against — mirrors the manual_entries columns. */
export interface ManualEntryFilterRow {
  entryKind: ManualEntryKind;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
}

function flowOverlapsYear(row: ManualEntryFilterRow, yearStart: string, yearEnd: string): boolean {
  return (row.startDate ?? "") <= yearEnd && (row.endDate ?? "") >= yearStart;
}

function balanceWithinYear(row: ManualEntryFilterRow, yearStart: string, yearEnd: string): boolean {
  const asOf = row.asOfDate ?? "";
  return asOf >= yearStart && asOf <= yearEnd;
}

/**
 * Evaluates whether a row would be returned by `filter`, in plain JS —
 * mirrors the Postgres conditions the route builds from the same filter so
 * the overlap semantics (e.g. a flow spanning Dec 31 -> Jan 1 belonging to
 * both years) are unit-testable without a database.
 */
export function matchesManualEntryFilter(filter: ManualEntryFilter, row: ManualEntryFilterRow): boolean {
  switch (filter.type) {
    case "none":
      return true;
    case "kind":
      return row.entryKind === filter.kind;
    case "kind-year":
      if (row.entryKind !== filter.kind) return false;
      return filter.kind === "flow"
        ? flowOverlapsYear(row, filter.yearStart, filter.yearEnd)
        : balanceWithinYear(row, filter.yearStart, filter.yearEnd);
    case "year":
      return row.entryKind === "flow"
        ? flowOverlapsYear(row, filter.yearStart, filter.yearEnd)
        : balanceWithinYear(row, filter.yearStart, filter.yearEnd);
  }
}
