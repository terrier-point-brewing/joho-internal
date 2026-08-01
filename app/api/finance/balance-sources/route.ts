/**
 * GET    /api/finance/balance-sources
 *          Every balance-sheet chart-of-accounts row with its declared
 *          balance_sheet_account_sources rows and the full provider catalog.
 * PUT    /api/finance/balance-sources   body { coaId, providerKey, config?, active? }
 *          Upserts ONE source. The table's PK is (chart_of_accounts_id,
 *          provider_key), so this never replaces an account's whole source
 *          list -- an account keeps every other provider it already has.
 * DELETE /api/finance/balance-sources   body { coaId, providerKey }
 *          Removes ONE source, same single-row semantics as PUT.
 *
 * Admin client, not the server client: these three tables' RLS is
 * lock-down-only (apply_grant_policies with no sibling read policy -- see
 * 20260905100000_balance_sheet_snapshots.sql's own note), so a session-scoped
 * client would silently see zero rows. Authorization is enforced here via
 * requirePermission on every verb, the same arrangement chart-of-accounts,
 * expenses and manual-entries already use.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
// Side-effect import: registers every provider AND every method so
// listMethods()/getMethod() below have something to return. Only this file and the
// cron route need it among Task 5's additions -- balance-close and
// manual-entries never touch the provider registry.
import "@/lib/finance/balances/methods";
import { getMethod, listMethods, stepKey } from "@/lib/finance/balances/methods/registry";
import { listConnections, describeConnection } from "@/lib/finance/balances/connections";
import type { CoaAccountRef } from "@/lib/finance/financials/types";
import { ACCOUNT_TYPE_SECTION } from "@/lib/finance/accountSections";

export const dynamic = "force-dynamic";

// Every non-P&L statement_section (lib/finance/accountSections.ts's
// StatementSection union minus its five P&L members) -- mirrors the BS/PL
// split lib/finance/financials/normalizeSign.ts's NEGATIVE_SECTIONS/
// POSITIVE_SECTIONS and summaries.ts's PL_SECTIONS both encode, kept local
// since neither exports a ready-made "is this a balance-sheet section" set.
const BALANCE_SHEET_SECTIONS = [
  "bank",
  "ar",
  "other_current_assets",
  "fixed_assets",
  "other_assets",
  "ap",
  "credit_card",
  "other_current_liabilities",
  "long_term_liabilities",
  "equity",
];

interface CoaRow {
  id: string;
  parent_id: string | null;
  account_name: string;
  account_number: string | null;
  statement_section: string | null;
}

interface SourceRow {
  chart_of_accounts_id: string;
  provider_key: string;
  config: Record<string, unknown>;
  active: boolean;
  updated_at: string;
}

interface BalanceRow {
  chart_of_accounts_id: string;
  period_end: string;
  balance_cents: number;
  contributions: Record<string, number>;
}

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();

    // `statement_section` is a nullable OVERRIDE, not the effective section:
    // 20260614_coa_parent_and_statement_section.sql says verbatim
    // "NULL = inferred from account_type". Filtering on it in SQL therefore
    // drops every account without an explicit override -- which is nearly all
    // of them -- and NULL never satisfies IN (...) anyway.
    //
    // That mismatch is load-bearing here: buildFinancials' unsourced-accounts
    // tile counts via coaSection() (the INFERRED section), so the tile would
    // say "41 accounts need a source", link to this screen, and this screen
    // would not list them. Fetch account_type and resolve the same way
    // coaSection does, then filter in JS.
    const { data: coaRows, error: coaError } = await supabase
      .from("chart_of_accounts")
      .select("id, parent_id, account_name, account_number, account_type, statement_section")
      .order("account_number", { ascending: true, nullsFirst: false });
    if (coaError) throw coaError;

    const bsSections = new Set<string>(BALANCE_SHEET_SECTIONS);
    // Resolve the EFFECTIVE section once and carry it forward.
    //
    // This previously resolved account_type here for the filter but then handed
    // the raw `statement_section` override to the CoaAccountRef below. Every
    // account in this chart of accounts has a NULL override, so that ref always
    // carried "" and every appliesTo predicate matched nothing -- the dropdown
    // would silently offer no calculation on any account, with no error to
    // explain why. Filter and predicate must see the same value.
    const accounts = ((coaRows ?? []) as (CoaRow & { account_type: string })[])
      .map((a) => ({ ...a, effectiveSection: a.statement_section ?? ACCOUNT_TYPE_SECTION[a.account_type] ?? "" }))
      .filter((a) => bsSections.has(a.effectiveSection));
    const coaIds = accounts.map((a) => a.id);

    let sourceRows: SourceRow[] = [];
    // Read-only "current balance / as of" column (Settings holds rules, never
    // dollar values -- see this route's own header) -- the latest
    // gl_account_balances row per account, contributions broken out per
    // provider so a balance is explainable at a glance without leaving this
    // screen.
    let balanceRows: BalanceRow[] = [];
    if (coaIds.length > 0) {
      const [sourcesRes, balancesRes] = await Promise.all([
        supabase
          .from("balance_sheet_account_sources")
          .select("chart_of_accounts_id, provider_key, config, active, updated_at")
          .in("chart_of_accounts_id", coaIds),
        supabase
          .from("gl_account_balances")
          .select("chart_of_accounts_id, period_end, balance_cents, contributions")
          .in("chart_of_accounts_id", coaIds)
          .order("period_end", { ascending: false }),
      ]);
      if (sourcesRes.error) throw sourcesRes.error;
      if (balancesRes.error) throw balancesRes.error;
      sourceRows = (sourcesRes.data ?? []) as SourceRow[];
      balanceRows = (balancesRes.data ?? []) as BalanceRow[];
    }

    const sourcesByCoa = new Map<string, SourceRow[]>();
    for (const row of sourceRows) {
      const bucket = sourcesByCoa.get(row.chart_of_accounts_id);
      if (bucket) bucket.push(row);
      else sourcesByCoa.set(row.chart_of_accounts_id, [row]);
    }

    // balanceRows is ordered period_end DESC, so the first row seen per coaId
    // is its latest snapshot.
    const latestBalanceByCoa = new Map<string, BalanceRow>();
    for (const row of balanceRows) {
      if (!latestBalanceByCoa.has(row.chart_of_accounts_id)) latestBalanceByCoa.set(row.chart_of_accounts_id, row);
    }

    const methods = listMethods();

    // Connections are looked up once and matched to a source by its
    // config.connectionId, so the Settings row can say "Ramp · Operating ·
    // synced 1 Aug" rather than just naming the method. Never carries
    // credentials -- listConnections cannot select that column.
    const connections = await listConnections(supabase);
    const connectionById = new Map(connections.map((c) => [c.id, c]));

    const body = {
      accounts: accounts.map((a) => {
        const coaRef: CoaAccountRef = {
          id: a.id,
          parentId: a.parent_id,
          accountName: a.account_name,
          accountNumber: a.account_number,
          statementSection: a.effectiveSection,
        };
        const latest = latestBalanceByCoa.get(a.id);
        return {
          id: a.id,
          accountName: a.account_name,
          accountNumber: a.account_number,
          statementSection: a.effectiveSection,
          sources: (sourcesByCoa.get(a.id) ?? []).map((s) => {
            const connectionId = (s.config ?? {}).connectionId;
            const connection = typeof connectionId === "string" ? connectionById.get(connectionId) : undefined;
            return {
              methodKey: s.provider_key,
              // Retained under its old name so an unmigrated row still renders
              // rather than showing a blank method.
              providerKey: s.provider_key,
              config: s.config,
              active: s.active,
              updatedAt: s.updated_at,
              // Present only for methods that declare a connection, so the UI
              // can tell "no integration" apart from "integration, not linked".
              connection: getMethod(s.provider_key)?.describeConnection
                ? describeConnection(connection ?? null)
                : null,
            };
          }),
          // Methods offerable for this account -- filtered server-side since
          // appliesTo is a function and not JSON-serializable. A method with no
          // appliesTo (manual entry, transaction postings) applies everywhere.
          availableMethodKeys: methods.filter((m) => !m.appliesTo || m.appliesTo(coaRef)).map((m) => m.key),
          currentBalance: latest
            ? { periodEnd: latest.period_end, cents: latest.balance_cents, contributions: latest.contributions }
            : null,
        };
      }),
      // Full step detail travels with the catalog so the "How is this
      // calculated?" panel renders from the same declaration the engine runs.
      // There is no second copy of this copy anywhere.
      methods: methods.map((m) => ({
        key: m.key,
        label: m.label,
        kind: m.kind,
        summary: m.summary,
        steps: m.steps.map((s) => ({
          key: stepKey(s),
          label: s.label,
          description: s.description,
          source: s.source,
          direction: s.direction,
        })),
      })),
    };

    return NextResponse.json(body);
  } catch (err) {
    return apiError(err);
  }
}

interface PutBody {
  coaId?: string;
  providerKey?: string;
  config?: Record<string, unknown>;
  active?: boolean;
}

export async function PUT(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as PutBody;

    if (typeof body.coaId !== "string" || body.coaId.trim() === "") {
      return NextResponse.json({ error: "coaId is required" }, { status: 400 });
    }
    if (typeof body.providerKey !== "string" || body.providerKey.trim() === "") {
      return NextResponse.json({ error: "providerKey is required" }, { status: 400 });
    }
    // Writes may only ever assign a METHOD. A bare provider key stays readable
    // (expandSources falls back for unmigrated rows) but must not be creatable,
    // or the half-a-calculation state this whole layer exists to eliminate
    // would be reachable again straight through the API.
    if (!getMethod(body.providerKey)) {
      return NextResponse.json({ error: `Unknown balance method "${body.providerKey}"` }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();

    // Fetch-then-merge rather than a blind upsert: PUT only names the
    // fields the caller wants to change, and this table's PK is the
    // (coaId, providerKey) pair, so an absent `config`/`active` must keep
    // the existing value, not silently reset to the column default.
    const { data: existing, error: fetchError } = await supabase
      .from("balance_sheet_account_sources")
      .select("config, active")
      .eq("chart_of_accounts_id", body.coaId)
      .eq("provider_key", body.providerKey)
      .maybeSingle();
    if (fetchError) throw fetchError;

    const existingRow = existing as { config: Record<string, unknown>; active: boolean } | null;

    const row = {
      chart_of_accounts_id: body.coaId,
      provider_key: body.providerKey,
      config: "config" in body ? (body.config ?? {}) : (existingRow?.config ?? {}),
      active: "active" in body ? (body.active ?? true) : (existingRow?.active ?? true),
      updated_by: session.user.id,
    };

    const { data, error } = await supabase
      .from("balance_sheet_account_sources")
      .upsert(row, { onConflict: "chart_of_accounts_id,provider_key" })
      .select("chart_of_accounts_id, provider_key, config, active, updated_at")
      .single();
    if (error) throw error;

    const saved = data as SourceRow;
    return NextResponse.json({
      coaId: saved.chart_of_accounts_id,
      providerKey: saved.provider_key,
      config: saved.config,
      active: saved.active,
      updatedAt: saved.updated_at,
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as { coaId?: string; providerKey?: string };

    if (typeof body.coaId !== "string" || body.coaId.trim() === "") {
      return NextResponse.json({ error: "coaId is required" }, { status: 400 });
    }
    if (typeof body.providerKey !== "string" || body.providerKey.trim() === "") {
      return NextResponse.json({ error: "providerKey is required" }, { status: 400 });
    }
    // Deliberately NOT validated against the registry. A row naming a retired
    // method, or a legacy provider key left behind by a partial migration, is
    // exactly the row an operator most needs to be able to remove -- refusing
    // to delete what we refuse to recognise would strand it permanently.
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase
      .from("balance_sheet_account_sources")
      .delete()
      .eq("chart_of_accounts_id", body.coaId)
      .eq("provider_key", body.providerKey);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
