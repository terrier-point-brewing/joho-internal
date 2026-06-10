import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampTransactions } from "@/lib/ramp";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { apiError } from "@/lib/utils/api";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

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
      .select("total_value_change, cost_per_unit, quantity")
      .eq("type", "batch_use")
      .gte("created_at", from)
      .lte("created_at", to + "T23:59:59"),
    supabase
      .from("packaging_stock_adjustments")
      .select("total_value_change, cost_per_unit, quantity")
      .eq("type", "used")
      .gte("created_at", from)
      .lte("created_at", to + "T23:59:59"),
  ]);

  if (ingResult.error) throw new Error(`COGS ingredients query failed: ${ingResult.error.message}`);
  if (pkgResult.error) throw new Error(`COGS packaging query failed: ${pkgResult.error.message}`);

  // ── Revenue ────────────────────────────────────────────────────────────────
  const posOrders = allOrders.filter((o) => (o.source?.name ?? "") !== "Invoices");
  const invoiceOrders = allOrders.filter((o) => o.source?.name === "Invoices");

  const taproomReport = buildTaproomModelReport(posOrders, catalogItems, refunds);
  const taproomRevenue = TAPROOM_MODEL_CATEGORIES.reduce((sum, cat) => {
    if (EXCLUDED_CATEGORY_IDS.has(cat.id)) return sum;
    return sum + (taproomReport.byCategory[cat.id]?.netSalesCents ?? 0);
  }, 0) / 100;

  // Invoice revenue = sum of completed invoice orders
  const invoiceRevenue = invoiceOrders.reduce((sum, o) => {
    return sum + (o.total_money?.amount ? Number(o.total_money.amount) / 100 : 0);
  }, 0);

  // Manual entries
  const { data: manualEntries } = await supabase
    .from("manual_net_sales_entries")
    .select("start_date, end_date, amount_cents");
  const startDate = new Date(from + "T00:00:00");
  const endDate   = new Date(to   + "T00:00:00");
  let manualRevenue = 0;
  for (const entry of manualEntries ?? []) {
    const eStart = new Date(entry.start_date + "T00:00:00");
    const eEnd   = new Date(entry.end_date   + "T00:00:00");
    const oStart = startDate > eStart ? startDate : eStart;
    const oEnd   = endDate   < eEnd   ? endDate   : eEnd;
    if (oStart <= oEnd) {
      const eDays = Math.round((eEnd.getTime()   - eStart.getTime()) / 86_400_000) + 1;
      const oDays = Math.round((oEnd.getTime()   - oStart.getTime()) / 86_400_000) + 1;
      manualRevenue += Math.round(entry.amount_cents * oDays / eDays) / 100;
    }
  }

  const totalRevenue = taproomRevenue + invoiceRevenue + manualRevenue;

  // ── COGS ───────────────────────────────────────────────────────────────────
  const ingredientCost = (ingResult.data ?? []).reduce((s, r) => {
    return s + Math.abs(r.total_value_change ?? (r.quantity * (r.cost_per_unit ?? 0)));
  }, 0);
  const packagingCost = (pkgResult.data ?? []).reduce((s, r) => {
    return s + Math.abs(r.total_value_change ?? (r.quantity * (r.cost_per_unit ?? 0)));
  }, 0);
  const totalCogs = ingredientCost + packagingCost;

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
  const grossProfit    = totalRevenue - totalCogs;
  const operatingIncome = grossProfit - totalExpenses;

  return NextResponse.json({
    period: { from, to },
    revenue: {
      taproom:  Math.round(taproomRevenue * 100)  / 100,
      invoices: Math.round(invoiceRevenue * 100)  / 100,
      manual:   Math.round(manualRevenue * 100)   / 100,
      total:    Math.round(totalRevenue * 100)    / 100,
    },
    cogs: {
      ingredients: Math.round(ingredientCost * 100) / 100,
      packaging:   Math.round(packagingCost  * 100) / 100,
      total:       Math.round(totalCogs      * 100) / 100,
    },
    gross_profit:      Math.round(grossProfit      * 100) / 100,
    operating_expenses: Math.round(totalExpenses   * 100) / 100,
    expenses_by_category: Object.fromEntries(
      Object.entries(expensesByCategory).map(([k, v]) => [k, Math.round(v * 100) / 100])
    ),
    operating_income:  Math.round(operatingIncome  * 100) / 100,
  });
  } catch (err) {
    return apiError(err);
  }
}
