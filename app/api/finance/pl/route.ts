import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { getRampTransactions } from "@/lib/ramp";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { apiError } from "@/lib/utils/api";
import { sumAdjustmentCost } from "@/lib/finance/cogs";
import { computePlSummary, proratedManualRevenue } from "@/lib/finance/pl";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";

export const dynamic = "force-dynamic";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to   = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to date params are required" }, { status: 400 });
  }

  try {
  const supabase = await createSupabaseServerClient();

  const [
    catalogItems,
    allOrders,
    refunds,
    rampTxns,
    ingResult,
    pkgResult,
  ] = await Promise.all([
    fetchCatalogItems(),
    fetchCompletedOrders(from, to),
    fetchRefunds(from, to),
    getRampTransactions(from, to),
    supabase
      .from("stock_adjustments")
      .select("total_value_change_usd, cost_per_unit_usd, quantity")
      .eq("type", "batch_use")
      .gte("created_at", from)
      .lte("created_at", to + "T23:59:59"),
    supabase
      .from("packaging_stock_adjustments")
      .select("total_value_change_usd, cost_per_unit_usd, quantity")
      .eq("type", "used")
      .gte("created_at", from)
      .lte("created_at", to + "T23:59:59"),
  ]);

  if (ingResult.error) throw new Error(`COGS ingredients query failed: ${ingResult.error.message}`);
  if (pkgResult.error) throw new Error(`COGS packaging query failed: ${pkgResult.error.message}`);

  // ── Revenue ────────────────────────────────────────────────────────────────
  const posOrders = allOrders.filter((o) => !isInvoiceOrder(o));
  const invoiceOrders = allOrders.filter((o) => isInvoiceOrder(o));

  const taproomReport = buildTaproomModelReport(posOrders, catalogItems, refunds);
  // Taproom net sales stay in INTEGER CENTS here; the cents→dollars conversion
  // happens once, inside computePlSummary.
  const taproomNetSalesCents = TAPROOM_MODEL_CATEGORIES.reduce((sum, cat) => {
    if (EXCLUDED_CATEGORY_IDS.has(cat.id)) return sum;
    return sum + (taproomReport.byCategory[cat.id]?.netSalesCents ?? 0);
  }, 0);

  // Invoice revenue = sum of completed invoice orders, in INTEGER CENTS.
  const invoiceTotalCents = invoiceOrders.reduce((sum, o) => {
    return sum + (o.total_money?.amount ? Number(o.total_money.amount) : 0);
  }, 0);

  // Manual entries (amount_cents) prorated onto the window → dollars.
  const { data: manualEntries } = await supabase
    .from("manual_entries")
    .select("start_date, end_date, amount_cents")
    .eq("entry_kind", "flow");
  const manualRevenue = proratedManualRevenue(manualEntries ?? [], from, to);

  // ── COGS ───────────────────────────────────────────────────────────────────
  // KNOWN TIMING POLICY: ingredient costs accrue at brew-turn start (tank assignment)
  // while packaging costs accrue at kegging/canning transfer time. These are two
  // different points in the batch lifecycle and can fall in different reporting periods.
  // TODO: align both to "COGS on cold-storage arrival" by joining stock_adjustments
  // through batch_transfers WHERE transfer_type IN ('kegging','canning') to match
  // ingredient costs to the period the batch was actually packaged.
  const ingredientCost = sumAdjustmentCost(ingResult.data ?? []);
  const packagingCost = sumAdjustmentCost(pkgResult.data ?? []);

  // ── Operating Expenses (Ramp) ──────────────────────────────────────────────
  const clearedTxns  = rampTxns.filter((t) => t.state === "CLEARED");
  const totalExpenses = clearedTxns.reduce((s, t) => s + t.amount, 0);

  // Group by category
  const expensesByCategory: Record<string, number> = {};
  for (const t of clearedTxns) {
    const cat = t.merchant_category_code_description;
    expensesByCategory[cat] = (expensesByCategory[cat] ?? 0) + t.amount;
  }

  // ── Gross Profit / Net Income ──────────────────────────────────────────────
  const summary = computePlSummary({
    taproomNetSalesCents,
    invoiceTotalCents,
    manualRevenueDollars: manualRevenue,
    ingredientCostDollars: ingredientCost,
    packagingCostDollars: packagingCost,
    operatingExpensesDollars: totalExpenses,
  });

  return NextResponse.json({
    period: { from, to },
    revenue: summary.revenue,
    cogs: {
      ingredients: summary.cogs.ingredients,
      packaging:   summary.cogs.packaging,
      total:       summary.cogs.total,
      // Ingredients accrue at brew-turn start; packaging at kegging/canning transfer.
      // Both costs for the same batch may therefore land in different reporting periods.
      policy: "accrual_at_activity_date",
    },
    gross_profit:      summary.grossProfit,
    operating_expenses: summary.operatingExpenses,
    expenses_by_category: Object.fromEntries(
      Object.entries(expensesByCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    operating_income:  summary.operatingIncome,
  });
  } catch (err) {
    return apiError(err);
  }
}
