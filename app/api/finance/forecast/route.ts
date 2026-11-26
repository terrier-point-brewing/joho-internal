// GET /api/finance/forecast
//
// The production and invoice history the Financials forecast needs on top of
// the statement rows the browser already holds. The forecast arithmetic itself
// runs client-side (lib/finance/forecast/forecast.ts), so moving a scenario
// lever never costs a round trip. Read-only.
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { fetchForecastDrivers } from "@/lib/finance/forecast/drivers.server";
import { computeCashOnHandCents } from "@/lib/finance/balances/cashRunway";
// Side-effect import: registers the balance providers the cash-on-hand read
// resolves against, exactly as the financials route does.
import "@/lib/finance/balances/methods";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();
    const today = todayLocalDate();
    // Best-effort, as on the cash-flow statement: a failed cash read costs the
    // projected-cash line, not the forecast.
    const cashOnHand = await computeCashOnHandCents(supabase, today).catch((err) => {
      console.error("[forecast] cash-on-hand read failed", err);
      return null;
    });
    return NextResponse.json(await fetchForecastDrivers(supabase, today, cashOnHand));
  } catch (err) {
    return apiError(err);
  }
}
