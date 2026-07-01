/**
 * GET   /api/finance/expense-mappings[?source=ramp]
 *         List external-account → CoA rules (one per source account) with the
 *         mapped account.
 * PATCH /api/finance/expense-mappings
 *         Set a rule's account and cascade it to every non-manual expense on
 *         that account. Body: { source, external_account_id, chart_of_accounts_id | null }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

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
      chart_of_accounts!expense_account_mappings_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("external_account_name");

  if (source) query = query.eq("source", source);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    source: string;
    external_account_id: string;
    chart_of_accounts_id: string | null;
  };

  if (!body.source || !body.external_account_id) {
    return NextResponse.json({ error: "source and external_account_id required" }, { status: 400 });
  }

  const coaId = body.chart_of_accounts_id ?? null;
  const supabase = createSupabaseAdminClient();

  // Update the rule. A human touched it, so it's no longer an auto match.
  const { data: rule, error: ruleErr } = await supabase
    .from("expense_account_mappings")
    .update({ chart_of_accounts_id: coaId, auto_matched: false })
    .eq("source", body.source)
    .eq("external_account_id", body.external_account_id)
    .select("id, source, external_account_id, chart_of_accounts_id, auto_matched")
    .single();

  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });

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
