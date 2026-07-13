// Parses and validates the `statement`/`year` query params for
// GET /api/finance/financials. Pure logic (no NextRequest dependency) so it
// can be unit-tested directly -- this repo has no route-handler test
// harness (see lib/finance/financials/parseParams.test.ts).

import type { StatementKind } from "./types";

const STATEMENT_KINDS: readonly StatementKind[] = ["pl", "balance_sheet", "cash_flow"];

export type ParsedFinancialsParams =
  | { ok: true; statement: StatementKind; year: number }
  | { ok: false; error: string };

export function parseFinancialsParams(searchParams: URLSearchParams): ParsedFinancialsParams {
  const statementParam = searchParams.get("statement");
  if (!statementParam || !STATEMENT_KINDS.includes(statementParam as StatementKind)) {
    return { ok: false, error: `statement must be one of: ${STATEMENT_KINDS.join(", ")}` };
  }

  const yearParam = searchParams.get("year");
  const year = Number(yearParam);
  if (!yearParam || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, error: "year must be a valid integer (e.g. 2026)" };
  }

  return { ok: true, statement: statementParam as StatementKind, year };
}
