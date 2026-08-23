import { NextRequest, NextResponse, after } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { autoMapBankLedger } from "@/lib/finance/autoMap";
import { counterpartyKeyOf } from "@/lib/finance/bankLedgerInclusion";
import { isSelectableHandler, SINGLE_ACCOUNT } from "@/lib/finance/counterpartyHandlers";
import { isFlowType, flowNeedsAccount } from "@/lib/finance/flowTypes";
import { resolveCounterpartyClaims, claimKey, type CounterpartyClaim } from "@/lib/finance/balances/counterpartyClaims";

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
  /** The STORED handler. Not necessarily the effective one — a claim overrides it. */
  routing: string;
  /** What kind of movement this counterparty's bank lines are. Null = no opinion, leave them for review. */
  flow_type: string | null;
  chart_of_accounts: CoaJoin | null;
  /**
   * Set when something else already accounts for this counterparty (see
   * lib/finance/balances/counterpartyClaims.ts). The client renders these rows
   * read-only; PATCH refuses to write them.
   */
  claim: CounterpartyClaim | null;
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
    .select(`id, source, counterparty_key, counterparty_label, chart_of_accounts_id, auto_matched, routing, flow_type, chart_of_accounts!expense_counterparty_mappings_chart_of_accounts_id_fkey ( account_name, account_number )`)
    .order("counterparty_label", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows: CounterpartyRow[] = (ruleRows ?? []).map((r) => ({
    id: r.id as string,
    source: r.source as string,
    counterparty_key: r.counterparty_key as string,
    counterparty_label: r.counterparty_label as string,
    chart_of_accounts_id: r.chart_of_accounts_id as string | null,
    auto_matched: r.auto_matched as boolean,
    routing: r.routing as string,
    flow_type: (r.flow_type ?? null) as string | null,
    chart_of_accounts: (r.chart_of_accounts as unknown as CoaJoin | null) ?? null,
    claim: null,
  }));
  const seen = new Set(rows.map((r) => `${r.source} ${r.counterparty_key}`));

  // Not filtered by include_in_gl: a feed that is switched off is exactly the one
  // whose counterparties someone is about to sit down and code.
  const ledger = await fetchAllRows<{ source: string; counterparty_key: string | null; counterparty_name: string | null }>(() =>
    supabase
      .from("bank_ledger")
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
      routing: SINGLE_ACCOUNT,
      flow_type: null,
      chart_of_accounts: null,
      claim: null,
    });
  }

  // Anything already accounted for elsewhere. Resolved AFTER the union above so
  // a claim can cover a ledger-only counterparty that has never had a rule row
  // — which is exactly the Square case, since nothing ever seeded one.
  const claims = await resolveCounterpartyClaims(supabase, rows);
  for (const row of rows) row.claim = claims.get(claimKey(row)) ?? null;

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
    routing?: string;
    /** Null clears the rule's opinion; absent leaves it untouched. */
    flow_type?: string | null;
  };
  const source = body.source?.trim();
  const counterpartyKey = body.counterparty_key?.trim();
  if (!source || !counterpartyKey) return NextResponse.json({ error: "source and counterparty_key required" }, { status: 400 });

  // The registry replaced the DB check constraint (20260921090000), so it is
  // the only thing standing between a typo and a counterparty that silently
  // stops coding. Non-selectable handlers are refused here too: a claimed mode
  // is derived, never chosen, and letting one be written by hand would put back
  // the second source of truth claims exist to remove.
  if (body.routing !== undefined && !isSelectableHandler(body.routing)) {
    return NextResponse.json({ error: `Unknown routing '${body.routing}'.` }, { status: 400 });
  }

  // A rule may take no view on the flow (null), but it may never say
  // "unclassified": a rule whose conclusion is "somebody should look at this" is
  // indistinguishable from having no rule, and storing one would mean the grid
  // showed a row as auto-classified while still asking for a decision.
  if (body.flow_type !== undefined && body.flow_type !== null) {
    if (!isFlowType(body.flow_type) || body.flow_type === "unclassified") {
      return NextResponse.json({ error: `Unknown flow type '${body.flow_type}'.` }, { status: 400 });
    }
  }

  const supabase = createSupabaseAdminClient();

  // A counterparty something else already accounts for cannot be assigned here.
  // The panel renders these read-only, so reaching this is either a stale tab or
  // a direct call; both want the same answer rather than a silent write that the
  // next page load visibly discards.
  const label = body.counterparty_label ?? counterpartyKey;
  const claims = await resolveCounterpartyClaims(supabase, [
    { source, counterparty_key: counterpartyKey, counterparty_label: label },
  ]);
  const claimed = claims.get(claimKey({ source, counterparty_key: counterpartyKey }));
  if (claimed) {
    return NextResponse.json(
      { error: `${label} is already accounted for — ${claimed.badge}. Change it where it is set up.` },
      { status: 409 },
    );
  }

  // Identified by (feed, counterparty) rather than by row id, because the row
  // may not exist yet: a counterparty seen only in the bank ledger is listed
  // above with a null id, and this is where its rule first gets written. The
  // pair is the table's own unique key, so the upsert is exact.
  //
  // A routing-only update (from the settings toggle) must not clobber an
  // existing account choice or trigger the cascade below, so the two shapes of
  // update are kept apart.
  const isAccountUpdate = "chart_of_accounts_id" in body;
  const isFlowUpdate = "flow_type" in body;
  const patch: Record<string, unknown> = {
    source,
    counterparty_key: counterpartyKey,
    counterparty_label: label,
  };
  if (isAccountUpdate) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id ?? null;
    patch.auto_matched = false;
  }
  if (body.routing) patch.routing = body.routing;
  if (isFlowUpdate) {
    patch.flow_type = body.flow_type ?? null;
    // A flow that cannot hold an account drops the rule's account with it, for
    // the same reason resolveBankBackfill clears it on the row: an account left
    // on a transfer rule goes on feeding the balance sheet from every line the
    // rule touches, and nothing on screen would say so.
    if (body.flow_type !== null && !flowNeedsAccount(body.flow_type)) {
      patch.chart_of_accounts_id = null;
    }
  }

  const { data, error } = await supabase
    .from("expense_counterparty_mappings")
    .upsert(patch, { onConflict: "source,counterparty_key" })
    .select("id, source, counterparty_key, chart_of_accounts_id, routing, flow_type")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!isAccountUpdate && !isFlowUpdate) return NextResponse.json(data);

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
    // Runs for a flow-only rule as well: `coaId` may legitimately be null now
    // that a rule can classify without coding ("every Ramp wallet funding is an
    // internal transfer"), and gating on it would leave exactly those rules
    // doing nothing until somebody clicked Auto-map.
    if (!coaId && !isFlowUpdate) return;
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
