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
// (strandedDeposit, exciseCoverage.shipmentsMissingExcise, cashOnHandCents,
// operatingCashCents) is accepted as a parameter and passed through
// untouched — Task 6 (which does the DB fetch / cash-flow statement) supplies
// those.

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

// StatementSection values where a sales channel is actually expected.
// aggregateRows.ts's resolveExpenseLike hardcodes channel: "unknown" for
// every expense/bank/refund row (they have no sales channel dimension), so
// channel === "unknown" alone over-reports "uncategorized" for those rows.
// Only revenue/other-income rows (POS + invoice) are meant to carry a real
// channel -- gate the "uncategorized" signal on that.
const CHANNEL_EXPECTED_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income"]);

/**
 * "Uncategorized" = a row where a sales channel is expected but missing.
 * Shared by buildDataQuality (this file) and controls.ts's qualityBucket so
 * the KPI-strip count and the table's "quality" filter chip never disagree.
 */
export function isUncategorized(row: FinancialsRow): boolean {
  return row.channel === "unknown" && CHANNEL_EXPECTED_SECTIONS.has(row.statementSection);
}

/**
 * "Unknown volume" = a beer row whose BBL coverage isn't "full".
 *
 * Previously excluded by-the-glass DRAFT POS rows on the assumption they
 * could *never* resolve a real BBL. That's no longer true: lib/finance/
 * financials/volume.ts's rowBbl now derives draft-pour BBL from the sold
 * variation's fl-oz (parseFlOz), same as kegs/cans, so an ordinary draft row
 * resolves bblCoverage "full" and never reaches this predicate. A DRAFT row
 * that still lands here (bblCoverage !== "full") means variationName was
 * missing -- a genuine data gap, not routine draft revenue -- so it's
 * correctly flagged like any other under-covered beer row.
 * Shared by buildDataQuality (this file) and controls.ts's qualityBucket so
 * the KPI-strip count and the table's "quality" filter chip never disagree
 * (same precedent as isUncategorized above).
 */
export function isUnknownVolume(row: FinancialsRow): boolean {
  return row.bblCoverage !== "full";
}

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
  opts?: { cashOnHandCents?: number | null; operatingCashCents?: Record<string, number> | null },
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

  return {
    netIncomeCents,
    grossMarginPct,
    revenueCents,
    revenueMoMPct,
    // Operating cash flow is a cash-flow-statement figure (invoices filtered
    // to paid, expenses to cleared) -- not derivable from FinancialsRow[]
    // alone. Supplied by the caller (Task 6) from the cash-flow statement
    // mode; null = not yet available.
    operatingCashCents: opts?.operatingCashCents ?? null,
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
  // manualNetSales.ts's injectManualNetSales synthesizes a coaId:null taproom
  // revenue row for prorated manual_net_sales_entries adjustments -- a
  // deliberate top-line adjustment, not an unmapped-account classification
  // gap. Narrow exclusion keyed on sourceRef.table (not a broader
  // coaId-null carve-out) so it doesn't inflate the unmapped bucket.
  const unmappedRows = rows.filter((r) => r.coaId === null && r.sourceRef.table !== "manual_net_sales_entries");
  const uncategorizedRows = rows.filter(isUncategorized);
  const unknownVolumeRows = rows.filter(isUnknownVolume);

  return {
    unmapped: bucket(unmappedRows, opts.hrefs.unmapped),
    uncategorized: bucket(uncategorizedRows, opts.hrefs.uncategorized),
    unknownVolume: bucket(unknownVolumeRows, opts.hrefs.unknownVolume),
    strandedDeposit: { ...opts.strandedDeposit, href: opts.hrefs.strandedDeposit },
    exciseCoverage: { ...opts.exciseCoverage, href: opts.hrefs.exciseCoverage },
  };
}
