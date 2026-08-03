// GET /api/finance/financials?statement=pl|balance_sheet|cash_flow&year=YYYY
//
// Thin adapter over lib/finance/financials/buildFinancials -- parses/validates
// query params, enforces auth, delegates all business logic to the lib.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { buildFinancials, toWireResponse } from "@/lib/finance/financials";
import { parseFinancialsParams } from "@/lib/finance/financials/parseParams";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  const parsed = parseFinancialsParams(req.nextUrl.searchParams);
  if (!parsed.ok) return apiError(parsed.error, 400);

  try {
    const result = await buildFinancials({ statement: parsed.statement, year: parsed.year });
    return NextResponse.json(toWireResponse(result));
  } catch (err) {
    return apiError(err);
  }
}
