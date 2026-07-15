import { NextRequest, NextResponse, after } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapBankLedger } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .select(`id, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched, routing, chart_of_accounts!expense_counterparty_mappings_chart_of_accounts_id_fkey ( account_name, account_number )`)
    .order("counterparty_label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as {
    id: string;
    chart_of_accounts_id?: string | null;
    routing?: "single_account" | "payroll_split";
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  // A routing-only update (from the settings toggle) touches only `routing`
  // -- it must not clobber the rule's existing chart_of_accounts_id/auto_matched
  // or trigger the account-mapping cascade below.
  const update: { chart_of_accounts_id?: string | null; auto_matched?: boolean; routing?: "single_account" | "payroll_split" } = {};
  const isAccountUpdate = "chart_of_accounts_id" in body;
  if (isAccountUpdate) {
    update.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    update.auto_matched = false;
  }
  if (body.routing) update.routing = body.routing;

  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .update(update)
    .eq("id", body.id).select("id, counterparty_key, chart_of_accounts_id, routing").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!isAccountUpdate) return NextResponse.json(data);

  const counterpartyKey = data.counterparty_key as string;
  const coaId = data.chart_of_accounts_id as string | null;

  // Cascade to bank-sourced expenses that follow the rule (leave manual pins + already-mapped rows alone).
  let expensesUpdated = 0;
  if (coaId) {
    const { data: affected, error: expErr } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: coaId, mapping_source: "rule" })
      .eq("source", "ramp")
      .eq("counterparty_key", counterpartyKey)
      .neq("mapping_source", "manual")
      .is("chart_of_accounts_id", null)
      .select("id");
    if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 });
    expensesUpdated = affected?.length ?? 0;
  }

  // Cascade to bank-ledger rows for this counterparty, current + prior year, in the background.
  after(async () => {
    if (!coaId) return;
    const year = new Date().getFullYear();
    const ranges = [
      { from: `${year}-01-01`, to: `${year}-12-31` },
      { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    ];
    for (const r of ranges) {
      try {
        await autoMapBankLedger(supabase, { ...r, counterpartyKey });
      } catch (e) {
        console.error("[counterparty-mappings] bank-ledger cascade failed", { counterpartyKey, range: r, error: e });
      }
    }
  });

  return NextResponse.json({ ...data, expenses_updated: expensesUpdated });
}
