/**
 * GET /api/finance/statements?year=YYYY
 *
 * Returns aggregated financial statement data from two sources:
 *   1. square_transaction_line_items mapped to chart_of_accounts (POS revenue)
 *   2. invoice_line_items mapped to chart_of_accounts (invoice revenue/COGS)
 *
 * Response shape matches the structure needed for both P&L and Balance Sheet.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Map QuickBooks account_type strings to financial statement sections
const ACCOUNT_TYPE_SECTION: Record<string, "revenue" | "cogs" | "expenses" | "other_income" | "other_expense" | "bank" | "ar" | "other_current_assets" | "fixed_assets" | "ap" | "credit_card" | "other_current_liabilities" | "long_term_liabilities" | "equity"> = {
  "Income":                      "revenue",
  "Other Income":                "other_income",
  "Cost of Goods Sold":          "cogs",
  "Expenses":                    "expenses",
  "Other Expense":               "other_expense",
  "Bank":                        "bank",
  "Accounts receivable (A/R)":   "ar",
  "Other Current Assets":        "other_current_assets",
  "Fixed Assets":                "fixed_assets",
  "Accounts payable (A/P)":      "ap",
  "Credit Card":                 "credit_card",
  "Other Current Liabilities":   "other_current_liabilities",
  "Long Term Liabilities":       "long_term_liabilities",
  "Equity":                      "equity",
};

export interface AccountBalance {
  id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  section: string;
  balance_cents: number;
  source_count: number;
}

export async function GET(req: NextRequest) {
  try { await requireRole("viewer"); } catch (res) { return res as Response; }

  const year    = Number(req.nextUrl.searchParams.get("year") ?? new Date().getFullYear());
  const month   = Number(req.nextUrl.searchParams.get("month") ?? 0); // 0 = full year
  const start   = month > 0
    ? `${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`
    : `${year}-01-01T00:00:00Z`;
  const end     = month > 0
    ? new Date(Date.UTC(year, month, 1)).toISOString()   // first of next month
    : `${year + 1}-01-01T00:00:00Z`;
  const supabase = createSupabaseAdminClient();

  // Load all CoA accounts
  const { data: accounts, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_number, account_name, account_type, statement_section")
    .order("account_type")
    .order("account_number", { nullsFirst: false })
    .order("account_name");

  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });

  // Aggregate square transaction line items by CoA (income/COGS/expense)
  const { data: txnAgg } = await supabase
    .from("square_transaction_line_items")
    .select(`
      chart_of_accounts_id,
      net_sales_cents,
      square_transactions!inner ( transaction_date )
    `)
    .gte("square_transactions.transaction_date", start)
    .lt("square_transactions.transaction_date", end)
    .not("chart_of_accounts_id", "is", null);

  // Aggregate invoice line items by CoA
  const { data: invAgg } = await supabase
    .from("invoice_line_items")
    .select(`
      chart_of_accounts_id,
      total_cents,
      invoices!inner ( invoice_date, status )
    `)
    .gte("invoices.invoice_date", `${year}-01-01`)
    .lte("invoices.invoice_date", `${year}-12-31`)
    .neq("invoices.status", "voided")
    .not("chart_of_accounts_id", "is", null);

  // Build balance map: coa_id → { total_cents, count }
  const balanceMap = new Map<string, { cents: number; count: number }>();

  for (const row of txnAgg ?? []) {
    if (!row.chart_of_accounts_id) continue;
    const cur = balanceMap.get(row.chart_of_accounts_id) ?? { cents: 0, count: 0 };
    balanceMap.set(row.chart_of_accounts_id, {
      cents: cur.cents + (row.net_sales_cents ?? 0),
      count: cur.count + 1,
    });
  }

  for (const row of invAgg ?? []) {
    if (!row.chart_of_accounts_id) continue;
    const cur = balanceMap.get(row.chart_of_accounts_id) ?? { cents: 0, count: 0 };
    balanceMap.set(row.chart_of_accounts_id, {
      cents: cur.cents + (row.total_cents ?? 0),
      count: cur.count + 1,
    });
  }

  const result: AccountBalance[] = (accounts ?? []).map((acct) => {
    const bal = balanceMap.get(acct.id) ?? { cents: 0, count: 0 };
    return {
      id:            acct.id,
      account_number: acct.account_number,
      account_name:  acct.account_name,
      account_type:  acct.account_type,
      section:       (acct as { statement_section?: string | null }).statement_section ?? ACCOUNT_TYPE_SECTION[acct.account_type] ?? "other",
      balance_cents: bal.cents,
      source_count:  bal.count,
    };
  });

  return NextResponse.json({ year, accounts: result });
}
