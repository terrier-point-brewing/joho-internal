/**
 * The one judgement the Sales Tax panel's Filings column makes, kept out of the
 * component so it can be tested directly (same split as ./bankFeeds.ts).
 *
 * A Square tax can be configured from two directions that never saw each other:
 * this screen decides which liability account its collections land in, while
 * Settings → Tax → Tax Filing decides which return computes from it. When an
 * active filing depends on a tax that this screen excludes or leaves unmapped,
 * the return reports tax owed and the balance sheet carries nothing against it.
 */
import type { SquareTaxReference } from "@/lib/tax/squareTaxUsage";

export interface FilingAwareTaxRow {
  chart_of_accounts_id: string | null;
  excluded: boolean;
  filing_refs: SquareTaxReference[];
}

/** True when an active filing computes from this tax but the books won't carry it. */
export function isOrphanedFiling(row: FilingAwareTaxRow): boolean {
  return row.filing_refs.length > 0 && (row.excluded || !row.chart_of_accounts_id);
}
