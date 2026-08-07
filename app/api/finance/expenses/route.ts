/**
 * GET   /api/finance/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD[&source=ramp]
 *         List imported expenses (by accounting_date) with their resolved CoA.
 * PATCH /api/finance/expenses
 *         Pin (or clear) a per-expense CoA override, addressed by row id. A
 *         non-null account sets mapping_source='manual' (sync won't touch it);
 *         null re-resolves from the account's rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveExpenseMapping, type CounterpartyRuleRef, type MappingSource } from "@/lib/finance/expenses";
import { resolveExpenseGlLines } from "@/lib/finance/expenseGlLines";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  const from   = req.nextUrl.searchParams.get("from");
  const to     = req.nextUrl.searchParams.get("to");
  const source = req.nextUrl.searchParams.get("source");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("expenses")
    .select(`
      id,
      source,
      ramp_object,
      source_transaction_id,
      amount_cents,
      currency_code,
      memo,
      merchant_name,
      merchant_category,
      sk_category_name,
      state,
      card_holder_name,
      department_name,
      transaction_time,
      accounting_date,
      external_account_id,
      counterparty_key,
      counterparty_label,
      qb_sync_status,
      qb_synced_at,
      qb_remote_id,
      chart_of_accounts_id,
      mapping_source,
      inventory_alert_dismissed,
      unmapped_accepted,
      excluded_at,
      excluded_reason,
      chart_of_accounts!expenses_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("accounting_date", { ascending: false, nullsFirst: false })
    .order("transaction_time", { ascending: false, nullsFirst: false });

  if (from)   query = query.gte("accounting_date", from);
  if (to)     query = query.lte("accounting_date", to);
  if (source) query = query.eq("source", source);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as {
    id: string;
    source: string;
    external_account_id: string | null;
    chart_of_accounts_id: string | null;
    amount_cents: number;
    excluded_at: string | null;
    excluded_reason: string | null;
  }[];
  if (rows.length === 0) return NextResponse.json(rows);

  // Payroll-match state + resolved GL line(s) per expense, batched (not
  // per-row) so the Transactions UI can render match/split state without a
  // second round-trip per row.
  //
  // The source account's display name is a property of the account, not of the
  // transaction, so it lives once on expense_account_mappings (keyed source +
  // external_account_id) rather than being copied onto every expense row.
  const ids = rows.map((r) => r.id);
  const externalAccountIds = Array.from(
    new Set(rows.map((r) => r.external_account_id).filter((v): v is string => v !== null)),
  );
  const [matchesResult, splitsResult, accountsResult] = await Promise.all([
    supabase.from("payroll_period_expense_matches").select("expense_id, pay_period_id, matched_component").in("expense_id", ids),
    supabase
      .from("expense_gl_splits")
      .select("expense_id, chart_of_accounts_id, amount_cents, split_source, memo")
      .in("expense_id", ids),
    externalAccountIds.length > 0
      ? supabase
          .from("expense_account_mappings")
          .select("source, external_account_id, external_account_name")
          .in("external_account_id", externalAccountIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (matchesResult.error) return NextResponse.json({ error: matchesResult.error.message }, { status: 500 });
  if (splitsResult.error) return NextResponse.json({ error: splitsResult.error.message }, { status: 500 });
  if (accountsResult.error) return NextResponse.json({ error: accountsResult.error.message }, { status: 500 });

  const accountKey = (source: string, externalAccountId: string) => `${source}::${externalAccountId}`;
  const accountNameByKey = new Map(
    (accountsResult.data as { source: string; external_account_id: string; external_account_name: string | null }[])
      .map((a) => [accountKey(a.source, a.external_account_id), a.external_account_name]),
  );

  const matchByExpense = new Map<string, { payPeriodId: string; matchedComponent: "net_pay" | "taxes" | null }>(
    (matchesResult.data as { expense_id: string; pay_period_id: string; matched_component: string | null }[]).map((r) => [
      r.expense_id,
      {
        payPeriodId: r.pay_period_id,
        matchedComponent: r.matched_component === "net_pay" || r.matched_component === "taxes" ? r.matched_component : null,
      },
    ]),
  );
  const matchedPeriodIds = Array.from(new Set([...matchByExpense.values()].map((m) => m.payPeriodId)));

  let activePeriodIds = new Set<string>();
  const periodDatesById = new Map<string, { start: string; end: string }>();
  if (matchedPeriodIds.length > 0) {
    const [reportsResult, periodsResult] = await Promise.all([
      supabase
        .from("payroll_gl_reports")
        .select("pay_period_id")
        .in("pay_period_id", matchedPeriodIds)
        .is("superseded_at", null),
      supabase.from("pay_periods").select("id, start_date, end_date").in("id", matchedPeriodIds),
    ]);
    if (reportsResult.error) return NextResponse.json({ error: reportsResult.error.message }, { status: 500 });
    if (periodsResult.error) return NextResponse.json({ error: periodsResult.error.message }, { status: 500 });
    activePeriodIds = new Set((reportsResult.data as { pay_period_id: string }[]).map((r) => r.pay_period_id));
    for (const p of periodsResult.data as { id: string; start_date: string; end_date: string }[]) {
      periodDatesById.set(p.id, { start: p.start_date, end: p.end_date });
    }
  }

  const splitsByExpense = new Map<
    string,
    { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual"; memo: string | null }[]
  >();
  for (const r of splitsResult.data as {
    expense_id: string;
    chart_of_accounts_id: string;
    amount_cents: number;
    split_source: "payroll_auto" | "manual";
    memo: string | null;
  }[]) {
    const list = splitsByExpense.get(r.expense_id) ?? [];
    list.push({
      chartOfAccountsId: r.chart_of_accounts_id,
      amountCents: r.amount_cents,
      splitSource: r.split_source,
      memo: r.memo ?? null,
    });
    splitsByExpense.set(r.expense_id, list);
  }

  const enriched = rows.map((row) => {
    const match = matchByExpense.get(row.id);
    const payPeriodId = match?.payPeriodId;
    const dates = payPeriodId ? periodDatesById.get(payPeriodId) : undefined;
    const payrollMatch = payPeriodId
      ? {
          payPeriodId,
          periodStart: dates?.start ?? "",
          periodEnd: dates?.end ?? "",
          hasReport: activePeriodIds.has(payPeriodId),
          matchedComponent: match?.matchedComponent ?? null,
        }
      : null;
    const glLines = resolveExpenseGlLines(splitsByExpense.get(row.id) ?? [], {
      chartOfAccountsId: row.chart_of_accounts_id,
      amountCents: row.amount_cents,
    });
    const external_account_name = row.external_account_id
      ? accountNameByKey.get(accountKey(row.source, row.external_account_id)) ?? null
      : null;
    return { ...row, external_account_name, payrollMatch, glLines };
  });

  return NextResponse.json(enriched);
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as {
    id: string;
    chart_of_accounts_id?: string | null;
    inventory_alert_dismissed?: boolean;
    unmapped_accepted?: boolean;
  };

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Dismiss / un-dismiss the production-inventory alert for this expense. A single
  // boolean toggle, independent of CoA mapping — return early so the two don't tangle.
  if (typeof body.inventory_alert_dismissed === "boolean") {
    const { data, error } = await supabase
      .from("expenses")
      .update({ inventory_alert_dismissed: body.inventory_alert_dismissed })
      .eq("id", body.id)
      .select("id, inventory_alert_dismissed")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Manually accept an unmapped expense as not needing a real GL mapping —
  // independent of CoA mapping, so return early before the mapping logic below.
  if (typeof body.unmapped_accepted === "boolean") {
    const { data, error } = await supabase
      .from("expenses")
      .update({ unmapped_accepted: body.unmapped_accepted })
      .eq("id", body.id)
      .select("id, unmapped_accepted")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  let coaId: string | null = body.chart_of_accounts_id ?? null;
  let source: MappingSource = "manual";

  // Clearing the override → fall back to the account's rule (rule or unmapped).
  if (!coaId) {
    const { data: expense } = await supabase
      .from("expenses")
      .select("source, external_account_id, counterparty_key")
      .eq("id", body.id)
      .single();

    const glRules = new Map<string, { external_account_id: string; chart_of_accounts_id: string | null }>();
    if (expense?.external_account_id) {
      const { data: rule } = await supabase
        .from("expense_account_mappings")
        .select("external_account_id, chart_of_accounts_id")
        .eq("source", expense.source).eq("external_account_id", expense.external_account_id).single();
      if (rule) glRules.set(rule.external_account_id, rule);
    }
    const cpRules = new Map<string, CounterpartyRuleRef>();
    if (expense?.counterparty_key) {
      const { data: rule } = await supabase
        .from("expense_counterparty_mappings")
        .select("counterparty_key, chart_of_accounts_id, routing")
        .eq("source", expense.source).eq("counterparty_key", expense.counterparty_key).single();
      if (rule) cpRules.set(rule.counterparty_key, rule);
    }
    const resolved = resolveExpenseMapping(
      { external_account_id: expense?.external_account_id ?? null, counterparty_key: expense?.counterparty_key ?? null, mapping_source: "unmapped", chart_of_accounts_id: null },
      glRules, cpRules,
    );
    coaId  = resolved.chart_of_accounts_id;
    source = resolved.mapping_source;
  }

  const { data, error } = await supabase
    .from("expenses")
    .update({ chart_of_accounts_id: coaId, mapping_source: source })
    .eq("id", body.id)
    .select("id, chart_of_accounts_id, mapping_source")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
