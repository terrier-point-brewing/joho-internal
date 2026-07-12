/**
 * NC DOR Sales & Use Tax — calculation engine.
 *
 * Three pieces:
 *  - `computeNcDorFigures`  — pure worksheet builder. Splits the taxable base
 *    across the configured counties, routes each county's split to its tier's
 *    page-1 rate/transit lines and page-2 county rows, computes the state line
 *    and dependent totals, and flags a reconciliation warning when the computed
 *    tax diverges from what Square actually collected.
 *  - `fetchTaxableBase`     — pulls the period's General-Sales-Tax base and the
 *    tax Square collected, by joining `pos_line_item_taxes` → `pos_line_items`
 *    → `square_orders`. Injectable `sb` so it's testable with a stub.
 *  - `computeNcDorWorksheet`— glue: reads config counties + the configured
 *    Square tax id from the ComputeContext, calls the two above.
 *
 * All money is integer cents. Every per-line tax is rounded with `Math.round`
 * exactly once, and page-1 line totals are the SUM of the per-county rounded
 * taxes (never an independent rounding of the line's aggregate receipts) — so
 * the page-2 county rows always reconcile to the page-1 lines by construction.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysStr } from "@/lib/utils/datetime";
import type { ComputeContext, TaxPeriod, WorksheetData } from "@/lib/tax/types";
import {
  NC_STATE_RATE,
  NC_COUNTY_TIERS,
  RATE_LINES,
  countyRateLine,
  transitRateLine,
} from "./rates";

/** A county entry from schedule.config: which county and its share of receipts. */
export interface CountyWeight {
  code: string;
  weight: number; // percentage (weights across all counties sum to 100)
}

export interface ComputeNcDorFiguresArgs {
  taxableBaseCents: number;
  counties: CountyWeight[];
  collectedGeneralTaxCents: number;
}

/**
 * Re-exported for backward-compat import sites (`./calc`'s `RATE_LINES` is
 * still the historical import path for the worksheet UI and tests); the
 * actual definition now lives in `./rates` so it stays reachable from the
 * pure `fieldOwnership.ts` module without dragging calc.ts's Supabase-admin
 * code path into the client bundle.
 */
export { RATE_LINES };

const round = (v: number) => Math.round(v);
const num = (v: number | string | null | undefined) => Number(v ?? 0);

/**
 * Apportion `total` cents across `counties` by weight using the largest-
 * remainder (Hamilton) method, so the allocations sum EXACTLY to `total` with
 * no lost or duplicated cent. Dividing by the actual weight sum (not a hardcoded
 * 100) keeps the split exact even if weights are mis-configured — a separate
 * warning flags that case.
 */
function allocateByWeight(total: number, counties: CountyWeight[]): number[] {
  const totalWeight = counties.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return counties.map(() => 0);
  const raw = counties.map((c) => (total * c.weight) / totalWeight);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((s, v) => s + v, 0);
  const alloc = floors.slice();
  // hand out the leftover cents to the largest fractional parts first
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && order.length > 0; k++, remainder--) {
    alloc[order[k % order.length].i] += 1;
  }
  return alloc;
}

/**
 * Recompute the dependent totals (lines 13/15/21) from a field set. Shared with
 * the party template's `mergeWorksheet` so manual penalty/interest/credit edits
 * flow into line 21 through the same arithmetic used here.
 *
 * L13 = Σ tax on rate lines 4–12
 * L15 = L13 + L14 (excess collections)
 * L21 = L15 + penalty + interest − less_prepay + prepay_next − credit
 */
export function computeDependentTotals(
  fields: Record<string, number | string | null>,
): { line13_total: number; line15_total: number; line21_total_due: number } {
  const line13_total = RATE_LINES.reduce((s, n) => s + num(fields[`line${n}_tax`]), 0);
  const line15_total = line13_total + num(fields.line14_excess);
  const line21_total_due =
    line15_total +
    num(fields.line16_penalty) +
    num(fields.line17_interest) -
    num(fields.line18_less_prepay) +
    num(fields.line19_prepay_next) -
    num(fields.line20_credit);
  return { line13_total, line15_total, line21_total_due };
}

/**
 * Pure worksheet builder — the heart of the NC DOR calc. See file header.
 */
export function computeNcDorFigures(args: ComputeNcDorFiguresArgs): WorksheetData {
  const { taxableBaseCents, counties, collectedGeneralTaxCents } = args;
  const warnings: string[] = [];

  const fields: Record<string, number | string | null> = {
    line1_gross_receipts: taxableBaseCents,
    line2_sales_for_resale: 0,
    line3_exempt: 0,
    line14_excess: 0,
    line16_penalty: 0,
    line17_interest: 0,
    line18_less_prepay: 0,
    line19_prepay_next: 0,
    line20_credit: 0,
    line20_credit_explanation: "",
  };
  for (const n of RATE_LINES) {
    fields[`line${n}_purchases`] = 0;
    fields[`line${n}_receipts`] = 0;
    fields[`line${n}_tax`] = 0;
  }

  // Line 4 — state tax on the full base @ 4.75%.
  fields.line4_receipts = taxableBaseCents;
  fields.line4_tax = round(taxableBaseCents * NC_STATE_RATE);

  // Validate the configured weights (Hamilton split stays exact regardless).
  const totalWeight = counties.reduce((s, c) => s + c.weight, 0);
  if (counties.length > 0 && totalWeight !== 100) {
    warnings.push(
      `Configured county weights sum to ${totalWeight}, not 100. Base was apportioned proportionally — review the county configuration.`,
    );
  }

  const bases = allocateByWeight(taxableBaseCents, counties);

  counties.forEach((county, i) => {
    const code = county.code;
    const countyBase = bases[i];
    const tier = NC_COUNTY_TIERS[code];

    // Always initialise the page-2 rows for a selected county.
    fields[`county_${code}_2pct`] = 0;
    fields[`county_${code}_225pct`] = 0;
    fields[`county_${code}_transit`] = 0;

    if (!tier) {
      warnings.push(`Unknown county code "${code}" — its receipts were not taxed. Check the county configuration.`);
      return;
    }

    const localTax = round(countyBase * tier.local);
    const transitTax = round(countyBase * tier.transit);

    // Page-2 county rows (per county).
    if (tier.local === 0.0225) {
      fields[`county_${code}_225pct`] = localTax;
    } else {
      fields[`county_${code}_2pct`] = localTax;
    }
    fields[`county_${code}_transit`] = transitTax;

    // Page-1 aggregation: line totals are the SUM of per-county rounded taxes.
    const localLine = countyRateLine(tier); // '9' | '10'
    fields[`line${localLine}_receipts`] = num(fields[`line${localLine}_receipts`]) + countyBase;
    fields[`line${localLine}_tax`] = num(fields[`line${localLine}_tax`]) + localTax;

    const transitLine = transitRateLine(tier); // '11' | '12' | null
    if (transitLine) {
      fields[`line${transitLine}_receipts`] = num(fields[`line${transitLine}_receipts`]) + countyBase;
      fields[`line${transitLine}_tax`] = num(fields[`line${transitLine}_tax`]) + transitTax;
    }
  });

  // Dependent totals.
  const totals = computeDependentTotals(fields);
  fields.line13_total = totals.line13_total;
  fields.line15_total = totals.line15_total;
  fields.line21_total_due = totals.line21_total_due;

  // Reconciliation: computed total general tax (L13) vs Square-collected.
  // Square rounds tax per transaction while this engine computes on the
  // aggregate monthly base, so a normal month drifts by tens of cents with NO
  // rate misconfiguration — that's expected rounding noise, not a bug. The
  // warning exists to catch a misconfigured rate/tier, which produces a large
  // *proportional* error, not a fixed few cents. Tolerance = 0.1% of collected
  // tax, floored at 100¢, so ordinary rounding drift never fires the warning
  // while a genuine rate/tier misconfiguration still does.
  const tolerance = Math.max(100, Math.round(collectedGeneralTaxCents * 0.001));
  const diff = Math.abs(totals.line13_total - collectedGeneralTaxCents);
  if (diff > tolerance) {
    warnings.push(
      `Computed general sales tax (${totals.line13_total}¢) differs from Square-collected (${collectedGeneralTaxCents}¢) by ${diff}¢, exceeding the ${tolerance}¢ rounding tolerance. Review before filing.`,
    );
  }

  const result: WorksheetData = {
    fields,
    meta: { computedAt: new Date().toISOString(), provenance: "square" },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

interface TaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  pos_line_items:
    | { net_sales_cents: number | null; tax_cents: number | null }
    | { net_sales_cents: number | null; tax_cents: number | null }[]
    | null;
}

/**
 * Pull the period's General-Sales-Tax base and Square-collected tax.
 *
 * Joins `pos_line_item_taxes` (filtered to `square_tax_id = generalSalesTaxId`)
 * → `pos_line_items` → `square_orders`, ranged over the period's
 * `transaction_date`. Filtering to one tax id yields exactly one tax row per
 * qualifying line, so a single pass gives, per line:
 *   base      = net_sales_cents − tax_cents  (post-discount, pre-tax receipts)
 *   collected = amount_cents                 (this tax's applied amount)
 * We dedupe defensively by `line_item_id` so a stray duplicate row can never
 * double-count a line's base or tax.
 *
 * `transaction_date` is a timestamp: the range is `[start 00:00Z, dayAfter(end)
 * 00:00Z)` so the whole final calendar day is included.
 */
export async function fetchTaxableBase(
  sb: SupabaseClient,
  generalSalesTaxId: string,
  period: TaxPeriod,
): Promise<{ baseCents: number; collectedCents: number }> {
  const startTs = `${period.start}T00:00:00Z`;
  const endExclusiveTs = `${addDaysStr(period.end, 1)}T00:00:00Z`;

  const { data, error } = await sb
    .from("pos_line_item_taxes")
    .select(
      "line_item_id, amount_cents, pos_line_items!inner ( net_sales_cents, tax_cents, square_orders!inner ( transaction_date ) )",
    )
    .eq("square_tax_id", generalSalesTaxId)
    .gte("pos_line_items.square_orders.transaction_date", startTs)
    .lt("pos_line_items.square_orders.transaction_date", endExclusiveTs);

  if (error) throw new Error(error.message);

  const seen = new Set<string>();
  let baseCents = 0;
  let collectedCents = 0;
  for (const row of (data ?? []) as TaxJoinRow[]) {
    if (seen.has(row.line_item_id)) continue;
    seen.add(row.line_item_id);
    const pliRaw = row.pos_line_items;
    const pli = Array.isArray(pliRaw) ? pliRaw[0] : pliRaw;
    if (!pli) continue;
    baseCents += num(pli.net_sales_cents) - num(pli.tax_cents);
    collectedCents += num(row.amount_cents);
  }
  return { baseCents, collectedCents };
}

/**
 * Compute the NC DOR worksheet for a filing period. Reads the configured
 * counties (`schedule.config.counties`) and the Square general-sales-tax id
 * (`profile.general_sales_tax_id`), pulls the taxable base from Square-synced
 * POS data, then builds the worksheet figures.
 *
 * `sb` defaults to the service-role admin client; it's injectable so this is
 * testable without a live DB.
 */
export async function computeNcDorWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
): Promise<WorksheetData> {
  const config = ctx.schedule.config as { counties?: CountyWeight[] };
  const counties = config.counties ?? [];
  const generalSalesTaxId = ctx.profile.general_sales_tax_id;

  if (!generalSalesTaxId) {
    return {
      fields: {},
      warnings: [
        "No Square General Sales Tax configured (profile.general_sales_tax_id is empty). Set it in Tax settings before recomputing.",
      ],
      meta: { computedAt: new Date().toISOString(), provenance: "square" },
    };
  }

  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const { baseCents, collectedCents } = await fetchTaxableBase(client, generalSalesTaxId, ctx.period);

  return computeNcDorFigures({
    taxableBaseCents: baseCents,
    counties,
    collectedGeneralTaxCents: collectedCents,
  });
}
