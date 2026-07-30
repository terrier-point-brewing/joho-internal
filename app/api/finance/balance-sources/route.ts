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
// Side-effect import: registers every balance provider so listProviders()/
// getProvider() below have something to return. Only this file and the
// cron route need it among Task 5's additions -- balance-close and
// manual-entries never touch the provider registry.
import "@/lib/finance/balances/providers";
import { getProvider, listProviders } from "@/lib/finance/balances/registry";

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

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();

    const { data: coaRows, error: coaError } = await supabase
      .from("chart_of_accounts")
      .select("id, account_name, account_number, statement_section")
      .in("statement_section", BALANCE_SHEET_SECTIONS)
      .order("account_number", { ascending: true, nullsFirst: false });
    if (coaError) throw coaError;

    const accounts = (coaRows ?? []) as CoaRow[];
    const coaIds = accounts.map((a) => a.id);

    let sourceRows: SourceRow[] = [];
    if (coaIds.length > 0) {
      const { data, error: sourcesError } = await supabase
        .from("balance_sheet_account_sources")
        .select("chart_of_accounts_id, provider_key, config, active, updated_at")
        .in("chart_of_accounts_id", coaIds);
      if (sourcesError) throw sourcesError;
      sourceRows = (data ?? []) as SourceRow[];
    }

    const sourcesByCoa = new Map<string, SourceRow[]>();
    for (const row of sourceRows) {
      const bucket = sourcesByCoa.get(row.chart_of_accounts_id);
      if (bucket) bucket.push(row);
      else sourcesByCoa.set(row.chart_of_accounts_id, [row]);
    }

    const body = {
      accounts: accounts.map((a) => ({
        id: a.id,
        accountName: a.account_name,
        accountNumber: a.account_number,
        statementSection: a.statement_section,
        sources: (sourcesByCoa.get(a.id) ?? []).map((s) => ({
          providerKey: s.provider_key,
          config: s.config,
          active: s.active,
          updatedAt: s.updated_at,
        })),
      })),
      providers: listProviders().map((p) => ({ key: p.key, label: p.label, kind: p.kind })),
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
    if (!getProvider(body.providerKey)) {
      return NextResponse.json({ error: `Unknown balance provider "${body.providerKey}"` }, { status: 400 });
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
    if (!getProvider(body.providerKey)) {
      return NextResponse.json({ error: `Unknown balance provider "${body.providerKey}"` }, { status: 400 });
    }

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
