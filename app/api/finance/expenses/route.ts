/**
 * GET   /api/finance/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD[&source=ramp]
 *         List imported expenses (by accounting_date) with their resolved CoA.
 * PATCH /api/finance/expenses
 *         Pin (or clear) a per-expense CoA override, addressed by row id. A
 *         non-null account sets mapping_source='manual' (sync won't touch it);
 *         null re-resolves from the account's rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveExpenseMapping, type MappingSource } from "@/lib/finance/expenses";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

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
      external_account_name,
      external_account_code,
      counterparty_key,
      counterparty_label,
      chart_of_accounts_id,
      mapping_source,
      inventory_alert_dismissed,
      unmapped_accepted,
      chart_of_accounts!expenses_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("accounting_date", { ascending: false, nullsFirst: false })
    .order("transaction_time", { ascending: false, nullsFirst: false });

  if (from)   query = query.gte("accounting_date", from);
  if (to)     query = query.lte("accounting_date", to);
  if (source) query = query.eq("source", source);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

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
    const cpRules = new Map<string, { counterparty_key: string; chart_of_accounts_id: string | null }>();
    if (expense?.counterparty_key) {
      const { data: rule } = await supabase
        .from("expense_counterparty_mappings")
        .select("counterparty_key, chart_of_accounts_id")
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
