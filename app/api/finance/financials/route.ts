// GET /api/finance/financials?statement=pl|balance_sheet|cash_flow&year=YYYY
//
// Thin adapter over lib/finance/financials/buildFinancials -- parses/validates
// query params, enforces auth, delegates all business logic to the lib.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { buildFinancials, toWireResponse } from "@/lib/finance/financials";
import { parseFinancialsParams } from "@/lib/finance/financials/parseParams";
import { computeCashOnHandCents, burnRateCents, runwayMonths } from "@/lib/finance/balances/cashRunway";
// Side-effect import: registers the balance providers the cash-on-hand read
// resolves against, exactly as the balance-sheet path does.
import "@/lib/finance/balances/methods";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  const parsed = parseFinancialsParams(req.nextUrl.searchParams);
  if (!parsed.ok) return apiError(parsed.error, 400);

  try {
    const result = await buildFinancials({ statement: parsed.statement, year: parsed.year });

    // Runway lives on the cash-flow statement, attached HERE because the
    // builder sits behind the statement-isolation boundary and cannot read the
    // balances tree. Cash on hand is the same figure the balance sheet's Bank
    // & Cash section shows; the burn it is divided by is the statement's own
    // operating cash, so the tile can never disagree with the columns under
    // it. Best-effort: a failed cash read leaves the statement intact with an
    // "n/a" tile rather than failing the request.
    if (parsed.statement === "cash_flow" && result.kpis.operatingCashCents) {
      const today = todayLocalDate();
      const openMonth = today.slice(0, 7);
      const cashOnHand = await computeCashOnHandCents(createSupabaseAdminClient(), today).catch((err) => {
        console.error("[financials] cash-on-hand read failed", err);
        return null;
      });
      const burn = burnRateCents(result.kpis.operatingCashCents, openMonth);
      result.kpis.cashOnHandCents = cashOnHand;
      result.kpis.burnRateCents = burn;
      result.kpis.runwayMonths = runwayMonths(cashOnHand, burn);
    }

    return NextResponse.json(toWireResponse(result));
  } catch (err) {
    return apiError(err);
  }
}
