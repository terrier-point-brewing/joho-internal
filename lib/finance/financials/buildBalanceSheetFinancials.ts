// The balance_sheet statement path (spec §4.5), extracted verbatim from
// buildFinancials.ts.
//
// It reads lib/finance/balances/snapshot.ts's fetchBalances for the trailing 12
// months' FROZEN snapshots, live-computes the CURRENT (not-yet-closed) month
// straight from the provider registry so the statement is never stale
// mid-month, and emits one FinancialsRow per sourced account. It never calls
// fetchFinancialsSources (that fetch layer is pl/cash_flow only) or
// aggregateRows (there is nothing to normalize -- providers already return
// internal-convention cents).
//
// ── Why this is its own module ───────────────────────────────────────────────
// The balance sheet is under active development (methods, integrations,
// month-end close) while the P&L and cash-flow statements are settled and
// verified. Sharing one file meant every balance-sheet edit reopened the P&L
// file for review and put it one careless keystroke away from a regression.
// Now the only thing they share is statementCommon.ts, and the isolation is
// enforced by scripts/check-statement-isolation.mjs rather than by care.
//
// Reads ONLY persisted tables (no live Square), so this module is
// Square-independent.

import { fetchCoa, fetchExciseCoverage, trailingMonths } from "./fetchSources";
import { coaSection } from "./aggregateRows";
import { buildKpis, buildDataQuality } from "./summaries";
import { HREFS, coaAccountRefsOf } from "./statementCommon";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBalances, resolveSnapshotWrites } from "@/lib/finance/balances/snapshot";
import { getProvider } from "@/lib/finance/balances/registry";
// Side-effect import: registers every balance provider (mirrors
// app/api/finance/balance-sources/route.ts's own import) so the live
// open-month compute below has something to call.
import "@/lib/finance/balances/providers";
import { monthEnd } from "@/lib/finance/manualEntries";
import type { FinancialsResponse, FinancialsRow, CoaAccountRef } from "./types";

// Mirrors app/api/finance/balance-sources/route.ts's BALANCE_SHEET_SECTIONS
// (every non-P&L statement_section) -- kept local for the same reason that
// route keeps its own copy: neither accountSections.ts nor normalizeSign.ts
// exports a ready-made "is this a balance-sheet section" set.
const BS_SECTIONS: ReadonlySet<string> = new Set([
  "bank", "ar", "other_current_assets", "fixed_assets", "other_assets",
  "ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity",
]);

/**
 * Live-computes the CURRENT period's balances straight from the provider
 * registry -- no write. Mirrors lib/finance/balances/snapshot.ts's
 * snapshotPeriod exactly (same source read, same per-provider compute, same
 * pure resolveSnapshotWrites decision logic) but read-only, so a mid-month
 * page view never shows a stale/missing gl_account_balances row for the
 * still-open month. A provider throwing for one source is isolated (treated
 * like a null result) so one bad source can't blank the whole statement.
 */
async function computeLiveBalances(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  periodEnd: string,
): Promise<Map<string, { balanceCents: number; contributions: Record<string, number> }>> {
  const { data: sourceRows, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key, config")
    .eq("active", true);
  if (error) throw new Error(error.message);

  const sources = ((sourceRows ?? []) as { chart_of_accounts_id: string; provider_key: string; config: Record<string, unknown> | null }[]).map(
    (r) => ({ coaId: r.chart_of_accounts_id, providerKey: r.provider_key, config: r.config ?? {} }),
  );

  const results = new Map<string, number | null>();
  // Same hazard snapshot.ts guards on the write path, and it applies just as
  // much here -- more, in fact, because this is the number the user actually
  // looks at. resolveSnapshotWrites cannot distinguish "provider returned null"
  // from "provider threw", so letting a failure fall through renders the
  // SURVIVING providers' partial sum as if it were the whole balance: GL 2220
  // would show -291,519 (accruals only) instead of 103,964, with no dash, no
  // banner and no fallback. Drop the account entirely instead -- a missing row
  // reads as unsourced, which is visibly wrong rather than plausibly wrong.
  const failedAccounts = new Set<string>();
  for (const source of sources) {
    const provider = getProvider(source.providerKey);
    if (!provider) {
      failedAccounts.add(source.coaId);
      continue;
    }
    try {
      const value = await provider.compute({ supabase, periodEnd, coaId: source.coaId, config: source.config });
      results.set(`${source.coaId}:${source.providerKey}`, value);
    } catch {
      failedAccounts.add(source.coaId);
    }
  }

  const writes = resolveSnapshotWrites(
    sources.map(({ coaId, providerKey }) => ({ coaId, providerKey })),
    results,
    new Map(), // nothing frozen for a live, unwritten compute
  ).filter((w) => !failedAccounts.has(w.coaId));

  const out = new Map<string, { balanceCents: number; contributions: Record<string, number> }>();
  for (const w of writes) out.set(w.coaId, { balanceCents: w.balanceCents, contributions: w.contributions });
  return out;
}

/** Every distinct balance-sheet-section CoA account with no active balance_sheet_account_sources row, for the Data Quality panel's unsourcedAccounts tile. */
async function countUnsourcedAccounts(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  coaAccounts: CoaAccountRef[],
): Promise<number> {
  const bsAccountIds = new Set(coaAccounts.filter((c) => BS_SECTIONS.has(c.statementSection)).map((c) => c.id));
  if (bsAccountIds.size === 0) return 0;

  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id")
    .eq("active", true);
  if (error) throw new Error(error.message);

  const sourced = new Set(((data ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id));
  let count = 0;
  for (const id of bsAccountIds) if (!sourced.has(id)) count++;
  return count;
}

export async function buildBalanceSheetFinancials(year: number): Promise<FinancialsResponse> {
  const supabase = createSupabaseAdminClient();
  const now = new Date();
  const months = trailingMonths(year, now);
  // The last month in `months` is only "open" (still accruing, no frozen
  // snapshot yet) when the requested year IS the current year -- trailingMonths
  // constructs the window to end at December otherwise (see
  // fetchSources.ts's periodEndYearMonth), meaning every one of its months is
  // already fully in the past.
  const openMonth = year === now.getFullYear() ? months[months.length - 1] : null;

  const [coa, balances] = await Promise.all([fetchCoa(supabase), fetchBalances(supabase, months)]);
  const coaAccounts = coaAccountRefsOf(coa);
  const coaById = new Map(coa.map((c) => [c.id, c]));

  const [liveContributions, unsourcedCount, exciseCoverage] = await Promise.all([
    openMonth ? computeLiveBalances(supabase, monthEnd(`${openMonth}-01`)) : Promise.resolve(null),
    countUnsourcedAccounts(supabase, coaAccounts),
    fetchExciseCoverage(supabase, year),
  ]);

  const coaIds = new Set<string>(balances.keys());
  if (liveContributions) for (const id of liveContributions.keys()) coaIds.add(id);

  const rows: FinancialsRow[] = [];
  for (const coaId of coaIds) {
    const account = coaById.get(coaId);
    if (!account) continue; // defensive: a source/snapshot pointing at a deleted CoA row

    const amountCentsByMonth: Record<string, number> = {};
    for (const m of months) {
      amountCentsByMonth[m] =
        openMonth && m === openMonth && liveContributions?.has(coaId)
          ? liveContributions.get(coaId)!.balanceCents
          : balances.get(coaId)?.[m] ?? 0;
    }
    // Skip an account with no data in ANY month -- nothing to show, and
    // seedEmptyRootAccounts-equivalent zero-line seeding for BS accounts is
    // covered by buildTree.ts's own coaAccounts-driven root seeding.
    if (Object.values(amountCentsByMonth).every((v) => v === 0)) continue;

    rows.push({
      coaId,
      parentId: account.parentId,
      accountName: account.accountName,
      statementSection: coaSection(account),
      channel: "unknown",
      posCategory: null,
      kegSize: null,
      amountCentsByMonth,
      bblByMonth: Object.fromEntries(months.map((m) => [m, 0])),
      bblCoverage: "full",
      mappingSource: "rule",
      sourceRef: { table: "gl_account_balances", ids: [coaId] },
    });
  }

  const totalMonth = months[months.length - 1];
  const cashOnHandCents = rows
    .filter((r) => r.statementSection === "bank")
    .reduce((sum, r) => sum + (r.amountCentsByMonth[totalMonth] ?? 0), 0);

  const kpis = buildKpis(rows, months, { operatingCashCents: null, cashOnHandCents });
  const dataQuality = buildDataQuality(rows, {
    hrefs: HREFS,
    exciseCoverage,
    unmappedTaxes: { count: 0, cents: 0 },
    unsourcedAccounts: { count: unsourcedCount },
  });

  return { months, rows, coaAccounts, dataQuality, kpis };
}
