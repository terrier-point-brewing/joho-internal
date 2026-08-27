import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { affectsPlForFlowType, type FlowType } from "@/lib/finance/bankLedger";
import { isFlowType, flowNeedsAccount } from "@/lib/finance/flowTypes";
import { flowAllowsSplit } from "@/lib/finance/bankLedgerSplits";
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
  const visible = fetched.filter((row) => inclusion.allows(row));

  // The GL allocation of every split line in the window, fetched once.
  //
  // Sent with the grid rather than lazily per row: a split row's account cell
  // must show the allocation instead of an account picker the moment it renders,
  // and a per-row fetch would leave every split line briefly claiming to be
  // coded to nothing. There are a handful of these in a year.
  const splitsByParent = new Map<string, { chart_of_accounts_id: string; amount_cents: number; memo: string | null }[]>();
  if (visible.length > 0) {
    const { data: splitRows, error: splitErr } = await supabase
      .from("bank_ledger_gl_splits")
      .select("bank_ledger_id, chart_of_accounts_id, amount_cents, memo")
      .in("bank_ledger_id", visible.map((row) => row.id as string))
      .order("created_at", { ascending: true });
    if (splitErr) return NextResponse.json({ error: splitErr.message }, { status: 500 });
    for (const s of splitRows ?? []) {
      const key = s.bank_ledger_id as string;
      const list = splitsByParent.get(key) ?? [];
      list.push({
        chart_of_accounts_id: s.chart_of_accounts_id as string,
        amount_cents:         s.amount_cents as number,
        memo:                 (s.memo as string | null) ?? null,
      });
      splitsByParent.set(key, list);
    }
  }

  return NextResponse.json(
    visible.map((row) => {
      const payload = { ...row };
      for (const column of ["source", "counterparty_key", "include_in_gl"]) delete payload[column];
      payload.gl_splits = splitsByParent.get(row.id as string) ?? [];
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
    // Checked against the registry rather than left to the table's CHECK
    // constraint. The constraint would reject an unknown value too, but as a
    // 500 from Postgres several layers down; and a value this build does not
    // know is a client sending something a newer deploy invented, which is a
    // 400 about the request rather than a database error.
    if (!isFlowType(body.flow_type)) {
      return NextResponse.json({ error: `unknown flow_type: ${body.flow_type}` }, { status: 400 });
    }
    patch.flow_type = body.flow_type;
    patch.affects_pl = affectsPlForFlowType(body.flow_type as FlowType);
    patch.mapping_source = "manual";
    // Reclassifying to a flow that does not use an account CLEARS the account.
    // Hiding the picker is not enough: the balance-sheet reader (sumBank in
    // balances/providers/transactionPostings.ts) matches on chart_of_accounts_id
    // and never looks at flow_type, so an account left behind on a row someone
    // moved to "internal transfer" would go on moving a reported balance with
    // nothing on screen admitting it was still there.
    if (!flowNeedsAccount(body.flow_type)) patch.chart_of_accounts_id = null;
  }
  // A body carrying both a flow and an account is a client that has not caught up
  // with the flow it just sent -- the clear above wins, because "this flow does
  // not use an account" is a property of the flow and not a preference.
  if ("chart_of_accounts_id" in body && !(patch.flow_type && !flowNeedsAccount(patch.flow_type as string))) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    if (!patch.mapping_source) patch.mapping_source = body.chart_of_accounts_id ? "manual" : "unmapped";
  }
  if (typeof body.unmapped_accepted === "boolean") {
    patch.unmapped_accepted = body.unmapped_accepted;
  }

  const supabase = createSupabaseAdminClient();

  // A row leaving `balance_sheet_movement` loses its GL allocation with it.
  //
  // Same reasoning as the account clear above, one table across: only that flow
  // can carry a split (lib/finance/bankLedgerSplits.ts), and an allocation left
  // behind on a row someone moved to "internal transfer" would go on funding
  // four asset accounts through sumBankSplits with nothing on screen admitting
  // it was still there. Hiding the editor is not enough, for exactly the reason
  // hiding the account picker was not.
  //
  // Deleted BEFORE the update: if the delete fails the row keeps the flow its
  // splits belong to, which is recoverable. The reverse order can leave an
  // allocation orphaned under a flow that must not have one.
  const dropsSplits = Boolean(body.flow_type) && !flowAllowsSplit(body.flow_type);
  if (dropsSplits) {
    const { error: splitErr } = await supabase
      .from("bank_ledger_gl_splits").delete().eq("bank_ledger_id", body.id);
    if (splitErr) return NextResponse.json({ error: splitErr.message }, { status: 500 });
  } else if ("chart_of_accounts_id" in patch) {
    // Pinning ONE account on a row whose coding is an allocation is two answers
    // to one question, and the quiet resolutions are both bad: the account wins
    // and four asset balances silently change, or the allocation wins and the
    // operator's click did nothing. Refused instead, naming the way out. The
    // grid does not offer the picker on a split row, so this is a client that
    // has not caught up -- which is exactly what an edge check is for.
    const { data: existing, error: exErr } = await supabase
      .from("bank_ledger_gl_splits").select("id").eq("bank_ledger_id", body.id).limit(1);
    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });
    if ((existing ?? []).length > 0) {
      return NextResponse.json(
        { error: "This line is split across accounts. Clear the split before coding it to one account." },
        { status: 409 },
      );
    }
  }

  const { data, error } = await supabase.from("bank_ledger").update(patch).eq("id", body.id).select("id, flow_type, affects_pl, chart_of_accounts_id, mapping_source, unmapped_accepted").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // The grid replaces its row from this response, so a reclassification that
  // discarded an allocation has to say so -- otherwise the cell goes on
  // rendering split lines that no longer exist until the next reload. Every
  // other patch leaves the field off and the grid keeps what it has.
  return NextResponse.json(dropsSplits ? { ...data, gl_splits: [] } : data);
}
