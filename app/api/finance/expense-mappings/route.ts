/**
 * GET   /api/finance/expense-mappings[?source=ramp]
 *         List external-account → CoA rules (one per source account) with the
 *         mapped account.
 * PATCH /api/finance/expense-mappings
 *         Set a rule's account and cascade it to every non-manual expense on
 *         that account, and/or mark the rule excluded from the mapping
 *         coverage count. Body: { source, external_account_id,
 *         chart_of_accounts_id?, excluded? } — only the fields present are
 *         touched, so toggling one never clobbers the other.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  const source = req.nextUrl.searchParams.get("source");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("expense_account_mappings")
    .select(`
      id,
      source,
      external_account_id,
      external_account_name,
      external_account_code,
      chart_of_accounts_id,
      auto_matched,
      excluded,
      chart_of_accounts!expense_account_mappings_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("external_account_name");

  if (source) query = query.eq("source", source);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as {
    source: string;
    external_account_id: string;
    chart_of_accounts_id?: string | null;
    excluded?: boolean;
  };

  if (!body.source || !body.external_account_id) {
    return NextResponse.json({ error: "source and external_account_id required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // An excluded-only toggle must not touch the account or fire the expenses
  // cascade below — same "in body" split as expense-counterparty-mappings.
  const isAccountUpdate = "chart_of_accounts_id" in body;
  const patch: Record<string, unknown> = {};
  if (isAccountUpdate) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    // A human touched it, so it's no longer an auto match.
    patch.auto_matched = false;
  }
  if ("excluded" in body) patch.excluded = body.excluded;

  const { data: rule, error: ruleErr } = await supabase
    .from("expense_account_mappings")
    .update(patch)
    .eq("source", body.source)
    .eq("external_account_id", body.external_account_id)
    .select("id, source, external_account_id, chart_of_accounts_id, auto_matched, excluded")
    .single();

  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });

  if (!isAccountUpdate) return NextResponse.json({ rule });

  const coaId = rule.chart_of_accounts_id as string | null;

  // Cascade to expenses that follow the rule (leave manual pins alone).
  const { data: affected, error: expErr } = await supabase
    .from("expenses")
    .update({ chart_of_accounts_id: coaId, mapping_source: coaId ? "rule" : "unmapped" })
    .eq("source", body.source)
    .eq("external_account_id", body.external_account_id)
    .neq("mapping_source", "manual")
    .select("id");

  if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 });

  return NextResponse.json({ rule, expenses_updated: affected?.length ?? 0 });
}
