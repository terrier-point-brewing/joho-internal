// Shared date-range helpers for the Transactions tab's year-scoped filters.

export interface YearRange {
  from: string;
  to: string;
}

/** Full calendar-year range as "YYYY-01-01" / "YYYY-12-31", defaulting to the current year. */
export function defaultYearRange(year: number = new Date().getFullYear()): YearRange {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
