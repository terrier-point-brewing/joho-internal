/**
 * GET /api/finance/statements?year=YYYY[&month=M]
 * GET /api/finance/statements?view=mom&year=YYYY
 *
 * Returns aggregated financial statement data from two sources:
 *   1. pos_line_items mapped to chart_of_accounts (POS revenue)
 *   2. invoice_line_items mapped to chart_of_accounts (invoice revenue/COGS)
 *
 * Deposit recognition: invoice line items with bs/pl split accounts are
 * recorded to BS until their linked delivery invoice is paid, then shift to P&L.
 * Manual account_mode overrides ('force_bs' | 'force_pl') take priority.
 *
 * With view=mom: returns all months of the year as columns, plus parent_id for hierarchy.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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
  parent_id: string | null;
  balance_cents: number;
  source_count: number;
}

export interface AccountBalanceMoM {
  id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  section: string;
  parent_id: string | null;
  monthly: Record<string, { cents: number; count: number }>; // key = "YYYY-MM"
}

type InvRow = {
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
  delivery_invoice_id: string | null;
  account_mode: string | null;
  total_cents: number;
  invoices: { invoice_date: string; status: string };
};

/** Resolve the effective chart_of_accounts_id for a deposit-aware line item. */
function resolveCoaId(row: InvRow, paidDeliveryIds: Set<string>): string | null {
  const { account_mode, bs_chart_of_accounts_id, pl_chart_of_accounts_id, delivery_invoice_id, chart_of_accounts_id } = row;

  // Manual overrides take priority
  if (account_mode === "force_bs" && bs_chart_of_accounts_id) return bs_chart_of_accounts_id;
  if (account_mode === "force_pl" && pl_chart_of_accounts_id) return pl_chart_of_accounts_id;

  // Deposit recognition: has both BS and PL accounts
  if (bs_chart_of_accounts_id && pl_chart_of_accounts_id) {
    const deliveryPaid = delivery_invoice_id && paidDeliveryIds.has(delivery_invoice_id);
    return deliveryPaid ? pl_chart_of_accounts_id : bs_chart_of_accounts_id;
  }

  // Standard mapping
  return chart_of_accounts_id;
}

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const year  = Number(req.nextUrl.searchParams.get("year") ?? new Date().getFullYear());
  const view  = req.nextUrl.searchParams.get("view");

  const supabase = createSupabaseAdminClient();

  // Load all CoA accounts with parent_id
  const { data: accounts, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_number, account_name, account_type, statement_section, parent_id")
    .order("account_type")
    .order("account_number", { nullsFirst: false })
    .order("account_name");

  if (coaErr) return NextResponse.json({ error: coaErr.message }, { status: 500 });

  if (view === "mom") {
    const start = `${year}-01-01T00:00:00Z`;
    const end   = `${year + 1}-01-01T00:00:00Z`;

    const { data: txnRows } = await supabase
      .from("pos_line_items")
      .select(`
        chart_of_accounts_id,
        net_sales_cents,
        square_orders!inner ( transaction_date )
      `)
      .gte("square_orders.transaction_date", start)
      .lt("square_orders.transaction_date", end)
      .not("chart_of_accounts_id", "is", null);

    const { data: rawInvRows } = await supabase
      .from("invoice_line_items")
      .select(`
        chart_of_accounts_id,
        bs_chart_of_accounts_id,
        pl_chart_of_accounts_id,
        delivery_invoice_id,
        account_mode,
        total_cents,
        invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status )
      `)
      .gte("invoices.invoice_date", `${year}-01-01`)
      .lte("invoices.invoice_date", `${year}-12-31`)
      .neq("invoices.status", "voided")
      .or("chart_of_accounts_id.not.is.null,bs_chart_of_accounts_id.not.is.null");

    // Fetch paid-delivery invoice statuses for deposit recognition
    const deliveryIds = [...new Set(
      (rawInvRows ?? [])
        .map((r) => r.delivery_invoice_id)
        .filter((id): id is string => !!id)
    )];
    const paidDeliveryIds = new Set<string>();
    if (deliveryIds.length > 0) {
      const { data: deliveries } = await supabase
        .from("invoices")
        .select("id, status")
        .in("id", deliveryIds)
        .eq("status", "paid");
      for (const d of deliveries ?? []) paidDeliveryIds.add(d.id);
    }

    const invRows = (rawInvRows ?? []).map((r) => ({
      ...r,
      invoices: r.invoices as unknown as { invoice_date: string; status: string },
    }));

    // balanceMap: coa_id → month_key → { cents, count }
    const balanceMap = new Map<string, Map<string, { cents: number; count: number }>>();

    const getOrCreate = (coaId: string, monthKey: string) => {
      if (!balanceMap.has(coaId)) balanceMap.set(coaId, new Map());
      const mmap = balanceMap.get(coaId)!;
      if (!mmap.has(monthKey)) mmap.set(monthKey, { cents: 0, count: 0 });
      return mmap.get(monthKey)!;
    };

    for (const row of txnRows ?? []) {
      if (!row.chart_of_accounts_id) continue;
      const txn = row.square_orders as unknown as { transaction_date: string };
      const d = new Date(txn.transaction_date);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const cur = getOrCreate(row.chart_of_accounts_id, key);
      cur.cents += row.net_sales_cents ?? 0;
      cur.count += 1;
    }

    for (const row of invRows) {
      const coaId = resolveCoaId(row as InvRow, paidDeliveryIds);
      if (!coaId) continue;
      const parts = row.invoices.invoice_date.split("-");
      const key = `${parts[0]}-${parts[1]}`;
      const cur = getOrCreate(coaId, key);
      cur.cents += row.total_cents ?? 0;
      cur.count += 1;
    }

    const result: AccountBalanceMoM[] = (accounts ?? []).map((acct) => {
      const mmap = balanceMap.get(acct.id);
      const monthly: Record<string, { cents: number; count: number }> = {};
      if (mmap) {
        for (const [k, v] of mmap.entries()) monthly[k] = v;
      }
      return {
        id:             acct.id,
        account_number: acct.account_number,
        account_name:   acct.account_name,
        account_type:   acct.account_type,
        section:        (acct as { statement_section?: string | null }).statement_section ?? ACCOUNT_TYPE_SECTION[acct.account_type] ?? "other",
        parent_id:      (acct as { parent_id?: string | null }).parent_id ?? null,
        monthly,
      };
    });

    return NextResponse.json({ year, view: "mom", accounts: result });
  }

  if (view === "cash") {
    // Direct-method cash flow: same CoA structure as P&L, but invoices filtered
    // to status='paid' only. POS is always cash. Ramp (expenses) not yet connected.
    const start = `${year}-01-01T00:00:00Z`;
    const end   = `${year + 1}-01-01T00:00:00Z`;

    const { data: txnRows } = await supabase
      .from("pos_line_items")
      .select(`
        chart_of_accounts_id,
        net_sales_cents,
        square_orders!inner ( transaction_date )
      `)
      .gte("square_orders.transaction_date", start)
      .lt("square_orders.transaction_date", end)
      .not("chart_of_accounts_id", "is", null);

    // Cash basis: only invoices that have been paid (cash collected)
    const { data: rawInvRows } = await supabase
      .from("invoice_line_items")
      .select(`
        chart_of_accounts_id,
        total_cents,
        invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status )
      `)
      .gte("invoices.invoice_date", `${year}-01-01`)
      .lte("invoices.invoice_date", `${year}-12-31`)
      .eq("invoices.status", "paid")
      .not("chart_of_accounts_id", "is", null);

    const invRows = (rawInvRows ?? []).map((r) => ({
      ...r,
      invoices: r.invoices as unknown as { invoice_date: string; status: string },
    }));

    const balanceMap = new Map<string, Map<string, { cents: number; count: number }>>();
    const getOrCreate = (coaId: string, monthKey: string) => {
      if (!balanceMap.has(coaId)) balanceMap.set(coaId, new Map());
      const mmap = balanceMap.get(coaId)!;
      if (!mmap.has(monthKey)) mmap.set(monthKey, { cents: 0, count: 0 });
      return mmap.get(monthKey)!;
    };

    for (const row of txnRows ?? []) {
      if (!row.chart_of_accounts_id) continue;
      const txn = row.square_orders as unknown as { transaction_date: string };
      const d   = new Date(txn.transaction_date);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const cur = getOrCreate(row.chart_of_accounts_id, key);
      cur.cents += row.net_sales_cents ?? 0;
      cur.count += 1;
    }

    for (const row of invRows) {
      if (!row.chart_of_accounts_id) continue;
      const parts = row.invoices.invoice_date.split("-");
      const key = `${parts[0]}-${parts[1]}`;
      const cur = getOrCreate(row.chart_of_accounts_id, key);
      cur.cents += row.total_cents ?? 0;
      cur.count += 1;
    }

    const result: AccountBalanceMoM[] = (accounts ?? []).map((acct) => {
      const mmap = balanceMap.get(acct.id);
      const monthly: Record<string, { cents: number; count: number }> = {};
      if (mmap) for (const [k, v] of mmap.entries()) monthly[k] = v;
      return {
        id:             acct.id,
        account_number: acct.account_number,
        account_name:   acct.account_name,
        account_type:   acct.account_type,
        section:        (acct as { statement_section?: string | null }).statement_section ?? ACCOUNT_TYPE_SECTION[acct.account_type] ?? "other",
        parent_id:      (acct as { parent_id?: string | null }).parent_id ?? null,
        monthly,
      };
    });

    return NextResponse.json({ year, view: "cash", accounts: result });
  }

  // Single-period mode
  // cumulative=true → BS mode: accumulate from inception through end of period
  const month      = Number(req.nextUrl.searchParams.get("month") ?? 0);
  const cumulative = req.nextUrl.searchParams.get("cumulative") === "true";

  const end = month > 0
    ? new Date(Date.UTC(year, month, 1)).toISOString()
    : `${year + 1}-01-01T00:00:00Z`;
  const endDate = month > 0
    ? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)  // last day of month
    : `${year}-12-31`;

  // For P&L mode use a bounded start; for BS cumulative mode accumulate from all time
  const start = cumulative ? null : (
    month > 0
      ? `${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`
      : `${year}-01-01T00:00:00Z`
  );
  const invStart = cumulative ? null : (month > 0 ? `${year}-${String(month).padStart(2, "0")}-01` : `${year}-01-01`);

  let txnQuery = supabase
    .from("pos_line_items")
    .select(`chart_of_accounts_id, net_sales_cents, square_orders!inner ( transaction_date )`)
    .lt("square_orders.transaction_date", end)
    .not("chart_of_accounts_id", "is", null);
  if (start) txnQuery = txnQuery.gte("square_orders.transaction_date", start);

  const { data: txnAgg } = await txnQuery;

  let invQuery = supabase
    .from("invoice_line_items")
    .select(`
      chart_of_accounts_id,
      bs_chart_of_accounts_id,
      pl_chart_of_accounts_id,
      delivery_invoice_id,
      account_mode,
      total_cents,
      invoices!invoice_line_items_invoice_id_fkey ( invoice_date, status )
    `)
    .lte("invoices.invoice_date", endDate)
    .neq("invoices.status", "voided")
    .or("chart_of_accounts_id.not.is.null,bs_chart_of_accounts_id.not.is.null");
  if (invStart) invQuery = invQuery.gte("invoices.invoice_date", invStart);

  const { data: rawInvAgg } = await invQuery;

  // Fetch paid-delivery invoice statuses
  const deliveryIds = [...new Set(
    (rawInvAgg ?? [])
      .map((r) => r.delivery_invoice_id)
      .filter((id): id is string => !!id)
  )];
  const paidDeliveryIds = new Set<string>();
  if (deliveryIds.length > 0) {
    const { data: deliveries } = await supabase
      .from("invoices")
      .select("id, status")
      .in("id", deliveryIds)
      .eq("status", "paid");
    for (const d of deliveries ?? []) paidDeliveryIds.add(d.id);
  }

  const invAgg = (rawInvAgg ?? []).map((r) => ({
    ...r,
    invoices: r.invoices as unknown as { invoice_date: string; status: string },
  }));

  const balanceMap = new Map<string, { cents: number; count: number }>();

  for (const row of txnAgg ?? []) {
    if (!row.chart_of_accounts_id) continue;
    const cur = balanceMap.get(row.chart_of_accounts_id) ?? { cents: 0, count: 0 };
    balanceMap.set(row.chart_of_accounts_id, {
      cents: cur.cents + (row.net_sales_cents ?? 0),
      count: cur.count + 1,
    });
  }

  for (const row of invAgg) {
    const coaId = resolveCoaId(row as InvRow, paidDeliveryIds);
    if (!coaId) continue;
    const cur = balanceMap.get(coaId) ?? { cents: 0, count: 0 };
    balanceMap.set(coaId, {
      cents: cur.cents + (row.total_cents ?? 0),
      count: cur.count + 1,
    });
  }

  // A/R from open invoices: sum total_cents of open invoices as of the period end
  // and credit the first A/R account found in the CoA.
  const arAccount = (accounts ?? []).find(a => a.account_type === "Accounts receivable (A/R)");
  if (arAccount) {
    const { data: openInvoices } = await supabase
      .from("invoices")
      .select("total_cents")
      .eq("status", "open")
      .lte("invoice_date", endDate);
    const arCents = (openInvoices ?? []).reduce((s, inv) => s + inv.total_cents, 0);
    if (arCents > 0) {
      const cur = balanceMap.get(arAccount.id) ?? { cents: 0, count: 0 };
      balanceMap.set(arAccount.id, { cents: cur.cents + arCents, count: cur.count + (openInvoices?.length ?? 0) });
    }
  }

  const result: AccountBalance[] = (accounts ?? []).map((acct) => {
    const bal = balanceMap.get(acct.id) ?? { cents: 0, count: 0 };
    return {
      id:             acct.id,
      account_number: acct.account_number,
      account_name:   acct.account_name,
      account_type:   acct.account_type,
      section:        (acct as { statement_section?: string | null }).statement_section ?? ACCOUNT_TYPE_SECTION[acct.account_type] ?? "other",
      parent_id:      (acct as { parent_id?: string | null }).parent_id ?? null,
      balance_cents:  bal.cents,
      source_count:   bal.count,
    };
  });

  return NextResponse.json({ year, month: month || null, cumulative, accounts: result });
}
