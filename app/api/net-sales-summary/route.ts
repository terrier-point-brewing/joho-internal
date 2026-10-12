import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";

export const dynamic = "force-dynamic";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { proratedTaproomManualSalesCents, type TaproomManualEntry } from "@/lib/taproom/manualSalesEntries";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    // -----------------------------------------------------------------------
    // 1. Square POS net sales
    // -----------------------------------------------------------------------
    const [catalogItems, allOrders, refunds] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const posOrders = allOrders.filter((o) => !isInvoiceOrder(o));

    const result = buildTaproomModelReport(posOrders, catalogItems, refunds);
    let netSalesCents = TAPROOM_MODEL_CATEGORIES.reduce((sum, cat) => {
      if (EXCLUDED_CATEGORY_IDS.has(cat.id)) return sum;
      return sum + (result.byCategory[cat.id]?.netSalesCents ?? 0);
    }, 0);

    // -----------------------------------------------------------------------
    // 2. Manual entry adjustments — taproom revenue accounts only, prorated
    //    by day overlap. manual_entries is brewery-wide since PR #300, so the
    //    account filter is what keeps a payroll or COGS correction out of
    //    taproom sales. Rule lives in lib/taproom/manualSalesEntries.ts.
    // -----------------------------------------------------------------------
    const { data: manualEntries, error: manualErr } = await supabase
      .from("manual_entries")
      .select("start_date, end_date, amount_cents, chart_of_accounts:chart_of_accounts_id(account_number)")
      .eq("entry_kind", "flow");
    if (manualErr) throw manualErr;

    type ManualRow = {
      start_date: string;
      end_date: string;
      amount_cents: number;
      chart_of_accounts: { account_number: string | null } | { account_number: string | null }[] | null;
    };
    const entries: TaproomManualEntry[] = ((manualEntries ?? []) as unknown as ManualRow[]).map((e) => {
      const coa = Array.isArray(e.chart_of_accounts) ? e.chart_of_accounts[0] : e.chart_of_accounts;
      return {
        startDate: e.start_date,
        endDate: e.end_date,
        amountCents: e.amount_cents,
        accountNumber: coa?.account_number ?? null,
      };
    });
    netSalesCents += proratedTaproomManualSalesCents(entries, start, end);

    return NextResponse.json({ net_sales_cents: netSalesCents, start, end });
  } catch (err) {
    return apiError(err);
  }
}
