import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .select(`id, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched, chart_of_accounts!expense_counterparty_mappings_chart_of_accounts_id_fkey ( account_name, account_number )`)
    .order("counterparty_label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; chart_of_accounts_id: string | null };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .update({ chart_of_accounts_id: body.chart_of_accounts_id ?? null, auto_matched: false })
    .eq("id", body.id).select("id, chart_of_accounts_id").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
