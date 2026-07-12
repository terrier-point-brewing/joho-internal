// KPI health-strip + data-quality/reconciliation summaries for the
// consolidated financials view. Pure functions over the already-aggregated
// FinancialsRow[] (Task 4) — no DB/Square/React imports. Computed
// server-side so the KPI strip and the underlying statement can never
// disagree (spec §7).
//
// Percentages (grossMarginPct, revenueMoMPct) are plain numbers in "percent"
// units — e.g. 62.5 means 62.5%, not 0.625. Cents fields are integer cents.
//
// Brief-gap resolution: not everything in KpiSummary/DataQualitySummary is
// derivable from FinancialsRow[] alone (see lib/finance/financials/types.ts
// header comment). Row-derivable pieces are computed here; the rest
// (strandedDeposit, exciseCoverage.shipmentsMissingExcise, cashOnHandCents)
// is accepted as a parameter and passed through untouched — Task 6 (which
// does the DB fetch) supplies those.

import type { DataQualitySummary, FinancialsRow, KpiSummary } from "./types";

// StatementSection values that belong to the P&L (income statement), as
// opposed to Balance Sheet sections (bank, ar, ap, equity, ...). Mirrors
// lib/finance/accountSections.ts's StatementSection union.
const PL_SECTIONS: ReadonlySet<string> = new Set([
  "revenue",
  "cogs",
  "expenses",
  "other_income",
  "other_expense",
]);
const REVENUE_SECTIONS: ReadonlySet<string> = new Set(["revenue"]);
const COGS_SECTIONS: ReadonlySet<string> = new Set(["cogs"]);

/** Sums amountCentsByMonth for rows whose statementSection is in `sections`, per month. Amounts are already sign-normalized (income-like positive, cost-like negative). */
function sumSectionByMonth(
  rows: FinancialsRow[],
  months: string[],
  sections: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]));
  for (const row of rows) {
    if (!sections.has(row.statementSection)) continue;
    for (const m of months) {
      out[m] += row.amountCentsByMonth[m] ?? 0;
    }
  }
  return out;
}

export function buildKpis(
  rows: FinancialsRow[],
  months: string[],
  opts?: { cashOnHandCents?: number | null },
): KpiSummary {
  const netIncomeCents = sumSectionByMonth(rows, months, PL_SECTIONS);
  const revenueCents = sumSectionByMonth(rows, months, REVENUE_SECTIONS);
  const cogsCents = sumSectionByMonth(rows, months, COGS_SECTIONS); // <= 0

  const grossMarginPct: Record<string, number> = {};
  const revenueMoMPct: Record<string, number> = {};

  months.forEach((month, i) => {
    const revenue = revenueCents[month] ?? 0;
    const cogsAbs = Math.abs(cogsCents[month] ?? 0);
    grossMarginPct[month] = revenue === 0 ? 0 : ((revenue - cogsAbs) / revenue) * 100;

    if (i === 0) {
      // No prior month in the requested range to compare against.
      revenueMoMPct[month] = 0;
    } else {
      const prevRevenue = revenueCents[months[i - 1]] ?? 0;
      revenueMoMPct[month] = prevRevenue === 0 ? 0 : ((revenue - prevRevenue) / prevRevenue) * 100;
    }
  });

  // FinancialsRow carries no Balance-Sheet deltas / AR-AP timing, so a true
  // cash-basis figure isn't derivable here. Per the task brief,
  // operatingCashCents is derived from the same P&L-section rows as
  // netIncomeCents -- an accrual-basis proxy until a real cash-flow
  // computation lands (that needs BS data Task 6's DB fetch will supply).
  const operatingCashCents = { ...netIncomeCents };

  return {
    netIncomeCents,
    grossMarginPct,
    revenueCents,
    revenueMoMPct,
    operatingCashCents,
    cashOnHandCents: opts?.cashOnHandCents ?? null,
  };
}

/** Sums |amount| across every month bucket on a single row. */
function sumAbsAcrossMonths(row: FinancialsRow): number {
  return Object.values(row.amountCentsByMonth).reduce((sum, v) => sum + Math.abs(v), 0);
}

function bucket(rows: FinancialsRow[], href: string): { count: number; cents: number; href: string } {
  return {
    count: rows.length,
    cents: rows.reduce((sum, r) => sum + sumAbsAcrossMonths(r), 0),
    href,
  };
}

export function buildDataQuality(
  rows: FinancialsRow[],
  opts: {
    hrefs: {
      unmapped: string;
      uncategorized: string;
      unknownVolume: string;
      strandedDeposit: string;
      exciseCoverage: string;
    };
    strandedDeposit: { count: number; cents: number };
    exciseCoverage: { shipmentsMissingExcise: number };
  },
): DataQualitySummary {
  const unmappedRows = rows.filter((r) => r.coaId === null);
  const uncategorizedRows = rows.filter((r) => r.channel === "unknown");
  // Only beer/volume-bearing rows ever get a non-"full" bblCoverage (see
  // lib/finance/financials/volume.ts's rowBbl) -- non-beer rows are always
  // "full" with bbl 0, so this check is equivalent to "beer rows with
  // bblCoverage !== 'full'" without needing a separate beer flag.
  const unknownVolumeRows = rows.filter((r) => r.bblCoverage !== "full");

  return {
    unmapped: bucket(unmappedRows, opts.hrefs.unmapped),
    uncategorized: bucket(uncategorizedRows, opts.hrefs.uncategorized),
    unknownVolume: bucket(unknownVolumeRows, opts.hrefs.unknownVolume),
    strandedDeposit: { ...opts.strandedDeposit, href: opts.hrefs.strandedDeposit },
    exciseCoverage: { ...opts.exciseCoverage, href: opts.hrefs.exciseCoverage },
  };
}
