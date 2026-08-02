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
import { coaSection, type CoaRecord } from "./aggregateRows";
import { buildKpis, buildDataQuality } from "./summaries";
import { HREFS, coaAccountRefsOf } from "./statementCommon";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBalances } from "@/lib/finance/balances/snapshot";
// The open-month live compute now lives in the balances tree so the Settings
// screen can show the SAME figure this statement does. It used to be a private
// function here, which is why the two screens disagreed.
import { computeLiveBalances } from "@/lib/finance/balances/liveBalances";
// Side-effect import: registers every provider AND every method (the methods
// barrel pulls in the providers barrel first) so the live open-month compute
// below has something to resolve against.
import "@/lib/finance/balances/methods";
import { monthEnd } from "@/lib/finance/manualEntries";
import type { FinancialsResponse, FinancialsRow } from "./types";

// Mirrors app/api/finance/balance-sources/route.ts's BALANCE_SHEET_SECTIONS
// (every non-P&L statement_section) -- kept local for the same reason that
// route keeps its own copy: neither accountSections.ts nor normalizeSign.ts
// exports a ready-made "is this a balance-sheet section" set.
const BS_SECTIONS: ReadonlySet<string> = new Set([
  "bank", "ar", "other_current_assets", "fixed_assets", "other_assets",
  "ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity",
]);

/**
 * Every distinct balance-sheet-section CoA account with no active
 * balance_sheet_account_sources row, for the Data Quality panel's
 * unsourcedAccounts tile.
 *
 * A grouping account marked `excluded` has deliberately opted out of being
 * sourced on its own -- its balance is already the sum of its sub-accounts on
 * this same statement (buildTree.ts rolls that up) -- so it is dropped from
 * the candidate set entirely rather than counted as a permanent gap.
 */
async function countUnsourcedAccounts(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  coa: CoaRecord[],
): Promise<number> {
  const bsAccountIds = new Set(
    coa.filter((c) => !c.excluded && BS_SECTIONS.has(coaSection(c))).map((c) => c.id),
  );
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

  const [live, unsourcedCount, exciseCoverage] = await Promise.all([
    openMonth ? computeLiveBalances(supabase, monthEnd(`${openMonth}-01`)) : Promise.resolve(null),
    countUnsourcedAccounts(supabase, coa),
    fetchExciseCoverage(supabase, year),
  ]);
  const liveContributions = live?.balances ?? null;

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
