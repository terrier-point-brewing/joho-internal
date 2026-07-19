import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { affectsPlForFlowType, type FlowType } from "@/lib/finance/bankLedger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }
  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("ramp_bank_ledger")
    .select(`id, source_transaction_id, amount_cents, currency_code, description, counterparty_name, source_account_name, destination_account_name, flow_type, affects_pl, transaction_date, qb_sync_status, qb_synced_at, qb_remote_id, chart_of_accounts_id, mapping_source, unmapped_accepted`)
    .order("transaction_date", { ascending: false, nullsFirst: false });
  if (from) query = query.gte("transaction_date", from);
  if (to)   query = query.lte("transaction_date", to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; flow_type?: string; chart_of_accounts_id?: string | null; unmapped_accepted?: boolean };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.flow_type) {
    patch.flow_type = body.flow_type;
    patch.affects_pl = affectsPlForFlowType(body.flow_type as FlowType);
    patch.mapping_source = "manual";
  }
  if ("chart_of_accounts_id" in body) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    if (!patch.mapping_source) patch.mapping_source = body.chart_of_accounts_id ? "manual" : "unmapped";
  }
  if (typeof body.unmapped_accepted === "boolean") {
    patch.unmapped_accepted = body.unmapped_accepted;
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("ramp_bank_ledger").update(patch).eq("id", body.id).select("id, flow_type, affects_pl, chart_of_accounts_id, mapping_source, unmapped_accepted").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
