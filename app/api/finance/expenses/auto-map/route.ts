/**
 * POST /api/finance/expenses/auto-map?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Apply the source-account → CoA rules to unmapped, non-manual expenses in
 *   range (the same rules the Ramp sync auto-matches on import, re-applied on
 *   demand). Manual pins are left untouched. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Only rules that resolve to an account can map anything.
  const { data: rules, error: ruleErr } = await supabase
    .from("expense_account_mappings")
    .select("source, external_account_id, chart_of_accounts_id")
    .not("chart_of_accounts_id", "is", null);
  if (ruleErr) return NextResponse.json({ error: ruleErr.message }, { status: 500 });

  let mapped = 0;
  for (const rule of rules ?? []) {
    const { data: affected, error } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: rule.chart_of_accounts_id, mapping_source: "rule" })
      .eq("source", rule.source)
      .eq("external_account_id", rule.external_account_id)
      .neq("mapping_source", "manual")
      .is("chart_of_accounts_id", null)
      .gte("accounting_date", from)
      .lte("accounting_date", to)
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    mapped += affected?.length ?? 0;
  }

  return NextResponse.json({ mapped });
}
