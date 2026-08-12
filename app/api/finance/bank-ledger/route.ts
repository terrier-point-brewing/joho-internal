import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { affectsPlForFlowType, type FlowType } from "@/lib/finance/bankLedger";
import { loadBankLedgerInclusion, INCLUSION_COLUMNS, type InclusionFacts } from "@/lib/finance/bankLedgerInclusion";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");

  const supabase = createSupabaseAdminClient();
  // Which rows are accounting facts is the operator's standing rule, not the
  // importer's row flag. Plaid's Chase rows arrive include_in_gl=false so that
  // linking a bank cannot silently rewrite closed months; switching that feed on
  // in Settings → GL Mapping → Bank Feeds is what overrides it. This grid used
  // to hardcode `.eq("include_in_gl", true)`, which meant the switch read "Yes"
  // while the grid — the one place a row is coded to an account — still hid
  // every row it had turned on. With no rules stored, applyTo() emits that exact
  // predicate again, so the default view is unchanged.
  const inclusion = await loadBankLedgerInclusion(supabase);
  let query = inclusion.applyTo(
    supabase
      .from("bank_ledger")
      .select(`id, source_transaction_id, amount_cents, currency_code, description, source_account_name, destination_account_name, flow_type, affects_pl, transaction_date, qb_sync_status, qb_synced_at, qb_remote_id, chart_of_accounts_id, mapping_source, unmapped_accepted, ${INCLUSION_COLUMNS}`)
      .order("transaction_date", { ascending: false, nullsFirst: false }),
  );
  if (from) query = query.gte("transaction_date", from);
  if (to)   query = query.lte("transaction_date", to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // applyTo() is a superset — a feed switched on brings its counterparty
  // exclusions along, and only allows() knows about those. The inclusion columns
  // are dropped again so the grid's payload keeps the shape it already had.
  // Cast because the select is interpolated: PostgREST cannot type-check a
  // non-literal column list, the same reason INCLUSION_COLUMNS is typed `string`.
  const fetched = (data ?? []) as unknown as (InclusionFacts & Record<string, unknown>)[];
  return NextResponse.json(
    fetched
      .filter((row) => inclusion.allows(row))
      .map((row) => {
        const payload = { ...row };
        for (const column of ["source", "counterparty_key", "include_in_gl"]) delete payload[column];
        return payload;
      }),
  );
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
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
  const { data, error } = await supabase.from("bank_ledger").update(patch).eq("id", body.id).select("id, flow_type, affects_pl, chart_of_accounts_id, mapping_source, unmapped_accepted").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
