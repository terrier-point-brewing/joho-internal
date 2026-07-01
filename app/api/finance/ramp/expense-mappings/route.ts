/**
 * GET   /api/finance/ramp/expense-mappings
 *         List GL→CoA rules (one per Ramp GL account) with their mapped account.
 * PATCH /api/finance/ramp/expense-mappings
 *         Set a rule's account and cascade it to every non-manual expense on
 *         that GL account. Body: { ramp_gl_id, chart_of_accounts_id | null }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("ramp_gl_account_mappings")
    .select(`
      id,
      ramp_gl_id,
      ramp_gl_name,
      ramp_gl_code,
      chart_of_accounts_id,
      auto_matched,
      chart_of_accounts!ramp_gl_account_mappings_chart_of_accounts_id_fkey ( account_name, account_number, account_type )
    `)
    .order("ramp_gl_name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    ramp_gl_id: string;
    chart_of_accounts_id: string | null;
  };

  if (!body.ramp_gl_id) {
    return NextResponse.json({ error: "ramp_gl_id required" }, { status: 400 });
  }

  const coaId = body.chart_of_accounts_id ?? null;
  const supabase = createSupabaseAdminClient();

  // Update the rule. A human touched it, so it's no longer an auto match.
  const { data: rule, error: ruleErr } = await supabase
    .from("ramp_gl_account_mappings")
    .update({ chart_of_accounts_id: coaId, auto_matched: false })
    .eq("ramp_gl_id", body.ramp_gl_id)
    .select("id, ramp_gl_id, chart_of_accounts_id, auto_matched")
    .single();

  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });

  // Cascade to expenses that follow the rule (leave manual pins alone).
  const { data: affected, error: expErr } = await supabase
    .from("ramp_expenses")
    .update({ chart_of_accounts_id: coaId, mapping_source: coaId ? "rule" : "unmapped" })
    .eq("ramp_gl_id", body.ramp_gl_id)
    .neq("mapping_source", "manual")
    .select("id");

  if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 });

  return NextResponse.json({ rule, expenses_updated: affected?.length ?? 0 });
}
