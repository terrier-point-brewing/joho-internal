// Parses the `year` query param for GET /api/finance/export. Pure, so it can
// be unit-tested without a route-handler harness (same reason
// lib/finance/financials/parseParams.ts exists).

export type ParsedExportParams = { ok: true; year: number } | { ok: false; error: string };

export function parseExportYear(searchParams: URLSearchParams): ParsedExportParams {
  const yearParam = searchParams.get("year");
  const year = Number(yearParam);
  if (!yearParam || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: "year must be a valid integer (e.g. 2026)" };
  }
  return { ok: true, year };
}
