import { NextRequest, NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { autoMapBankLedger } from "@/lib/finance/autoMap";
import { counterpartyKeyOf } from "@/lib/finance/bankLedgerInclusion";

export const dynamic = "force-dynamic";

interface CoaJoin { account_name: string; account_number: string | null }

/** A saved rule, or a counterparty seen in the bank ledger that has no rule yet. */
interface CounterpartyRow {
  /** Null until a rule row exists — which is when someone first assigns something. */
  id: string | null;
  source: string;
  counterparty_key: string;
  counterparty_label: string;
  chart_of_accounts_id: string | null;
  auto_matched: boolean;
  routing: "single_account" | "payroll_split";
  chart_of_accounts: CoaJoin | null;
}

/**
 * Every counterparty a bookkeeper could need to code, from both places one can
 * come from.
 *
 * expense_counterparty_mappings holds the saved rules, but a row is only seeded
 * there by the Ramp expense sync — so a counterparty whose transactions all land
 * in the bank ledger rather than in `expenses` has never appeared on this
 * screen. That covers the transfers and deposits on the Ramp account, and it
 * covers everything the Plaid importer writes, since that importer has no rule
 * table of its own to seed. Those counterparties were unmappable purely because
 * nothing listed them.
 *
 * So the list is the union, and a ledger-only counterparty comes back with a
 * null id. PATCH creates the rule row the moment someone assigns something to
 * it, which keeps the rule table a record of decisions rather than a catalogue
 * of every name a bank has ever printed.
 */
export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  const supabase = createSupabaseAdminClient();

  const { data: ruleRows, error } = await supabase
    .from("expense_counterparty_mappings")
    .select(`id, source, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched, routing, chart_of_accounts!expense_counterparty_mappings_chart_of_accounts_id_fkey ( account_name, account_number )`)
    .order("counterparty_label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows: CounterpartyRow[] = (ruleRows ?? []).map((r) => ({
    id: r.id as string,
    source: r.source as string,
    counterparty_key: r.counterparty_key as string,
    counterparty_label: r.counterparty_label as string,
    chart_of_accounts_id: r.chart_of_accounts_id as string | null,
    auto_matched: r.auto_matched as boolean,
    routing: r.routing as CounterpartyRow["routing"],
    chart_of_accounts: (r.chart_of_accounts as unknown as CoaJoin | null) ?? null,
  }));
  const seen = new Set(rows.map((r) => `${r.source} ${r.counterparty_key}`));

  // Not filtered by include_in_gl: a feed that is switched off is exactly the one
  // whose counterparties someone is about to sit down and code.
  const ledger = await fetchAllRows<{ source: string; counterparty_key: string | null; counterparty_name: string | null }>(() =>
    supabase
      .from("ramp_bank_ledger")
      .select("source, counterparty_key, counterparty_name")
      .order("id", { ascending: true }),
  );
  for (const row of ledger) {
    const key = counterpartyKeyOf(row);
    if (!key) continue;
    const id = `${row.source} ${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id: null,
      source: row.source,
      counterparty_key: key,
      counterparty_label: row.counterparty_name ?? key,
      chart_of_accounts_id: null,
      auto_matched: false,
      routing: "single_account",
      chart_of_accounts: null,
    });
  }

  rows.sort((a, b) => a.source.localeCompare(b.source) || a.counterparty_label.localeCompare(b.counterparty_label));
  return NextResponse.json(rows);
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const body = await req.json() as {
    source?: string;
    counterparty_key?: string;
    counterparty_label?: string;
    chart_of_accounts_id?: string | null;
    routing?: "single_account" | "payroll_split";
  };
  const source = body.source?.trim();
  const counterpartyKey = body.counterparty_key?.trim();
  if (!source || !counterpartyKey) return NextResponse.json({ error: "source and counterparty_key required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  // Identified by (feed, counterparty) rather than by row id, because the row
  // may not exist yet: a counterparty seen only in the bank ledger is listed
  // above with a null id, and this is where its rule first gets written. The
  // pair is the table's own unique key, so the upsert is exact.
  //
  // A routing-only update (from the settings toggle) must not clobber an
  // existing account choice or trigger the cascade below, so the two shapes of
  // update are kept apart.
  const isAccountUpdate = "chart_of_accounts_id" in body;
  const patch: Record<string, unknown> = {
    source,
    counterparty_key: counterpartyKey,
    counterparty_label: body.counterparty_label ?? counterpartyKey,
  };
  if (isAccountUpdate) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    patch.auto_matched = false;
  }
  if (body.routing) patch.routing = body.routing;

  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .upsert(patch, { onConflict: "source,counterparty_key" })
    .select("id, source, counterparty_key, chart_of_accounts_id, routing")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!isAccountUpdate) return NextResponse.json(data);

  const coaId = data.chart_of_accounts_id as string | null;

  // Cascade to bank-sourced expenses that follow the rule (leave manual pins and
  // already-mapped rows alone). Scoped to the rule's OWN feed: the same payee
  // name on another bank is a separate rule with a separate account, and this
  // used to be hard-coded to Ramp.
  let expensesUpdated = 0;
  if (coaId) {
    const { data: affected, error: expErr } = await supabase
      .from("expenses")
      .update({ chart_of_accounts_id: coaId, mapping_source: "rule" })
      .eq("source", source)
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
        await autoMapBankLedger(supabase, { ...r, counterpartyKey, source });
      } catch (e) {
        console.error("[counterparty-mappings] bank-ledger cascade failed", { source, counterpartyKey, range: r, error: e });
      }
    }
  });

  return NextResponse.json({ ...data, expenses_updated: expensesUpdated });
}
