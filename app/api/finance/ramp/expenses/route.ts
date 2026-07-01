/**
 * GET   /api/finance/ramp/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD
 *         List imported expenses (by accounting_date) with their resolved CoA.
 * PATCH /api/finance/ramp/expenses
 *         Pin (or clear) a per-expense CoA override. A non-null account sets
 *         mapping_source='manual' (sync won't touch it); null re-resolves from
 *         the GL rule.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveExpenseMapping, type MappingSource } from "@/lib/finance/rampExpenses";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("ramp_expenses")
    .select(`
      id,
      ramp_transaction_id,
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
      ramp_gl_id,
      ramp_gl_name,
      ramp_gl_code,
      chart_of_accounts_id,
      mapping_source,
      chart_of_accounts!ramp_expenses_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("accounting_date", { ascending: false, nullsFirst: false })
    .order("transaction_time", { ascending: false, nullsFirst: false });

  if (from) query = query.gte("accounting_date", from);
  if (to)   query = query.lte("accounting_date", to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    ramp_transaction_id: string;
    chart_of_accounts_id: string | null;
  };

  if (!body.ramp_transaction_id) {
    return NextResponse.json({ error: "ramp_transaction_id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  let coaId: string | null = body.chart_of_accounts_id ?? null;
  let source: MappingSource = "manual";

  // Clearing the override → fall back to the GL rule (rule or unmapped).
  if (!coaId) {
    const { data: expense } = await supabase
      .from("ramp_expenses")
      .select("ramp_gl_id")
      .eq("ramp_transaction_id", body.ramp_transaction_id)
      .single();

    const ruleByGlId = new Map<string, { ramp_gl_id: string; chart_of_accounts_id: string | null }>();
    if (expense?.ramp_gl_id) {
      const { data: rule } = await supabase
        .from("ramp_gl_account_mappings")
        .select("ramp_gl_id, chart_of_accounts_id")
        .eq("ramp_gl_id", expense.ramp_gl_id)
        .single();
      if (rule) ruleByGlId.set(rule.ramp_gl_id, rule);
    }
    const resolved = resolveExpenseMapping(
      { ramp_gl_id: expense?.ramp_gl_id ?? null, mapping_source: "unmapped", chart_of_accounts_id: null },
      ruleByGlId,
    );
    coaId  = resolved.chart_of_accounts_id;
    source = resolved.mapping_source;
  }

  const { data, error } = await supabase
    .from("ramp_expenses")
    .update({ chart_of_accounts_id: coaId, mapping_source: source })
    .eq("ramp_transaction_id", body.ramp_transaction_id)
    .select("id, ramp_transaction_id, chart_of_accounts_id, mapping_source")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
