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
 *
 * Every rate VALUE is read from a `rateMap` (built via
 * `buildRateMap(await listTaxRates(sb))`, see `@/lib/tax/rates`) rather than
 * a code constant — `computeNcDorWorksheet` fetches it once per call and
 * threads it through `computeNcDorFigures` → `deriveNcDorFigures`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { buildRateMap, listTaxRates, ncLocalKey, ncTransitKey } from "@/lib/tax/rates";
import { fetchTaxableBase } from "@/lib/tax/squareTaxBase";
import {
  NC_COUNTIES,
  RATE_LINES,
  countyRateLine,
  transitRateLine,
} from "./rates";
import { allocateByWeights, computeDependentTotals, deriveNcDorFigures } from "./derive";

// Back-compat: existing import sites and tests import fetchTaxableBase from "./calc".
export { fetchTaxableBase };

/** Structural county-code allowlist — a county configured with an unknown
 * code (not one of the 100 NC DOR counties) is flagged, not silently taxed
 * at a 0 rate. */
const KNOWN_COUNTY_CODES = new Set(NC_COUNTIES.map((c) => c.code));

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

/**
 * Re-exported for backward-compat import sites (`./calc`'s `computeDependentTotals`
 * remains the historical import path used by `calc.test.ts` and the template).
 * The definition — along with the full shared figure derivation — now lives in
 * the pure `./derive` module so it stays client-importable without dragging
 * calc.ts's Supabase-admin code path into the browser bundle.
 */
export { computeDependentTotals };

const num = (v: number | string | null | undefined) => Number(v ?? 0);

/**
 * Pure worksheet builder — the initial Square compute (purchases implicitly 0).
 *
 * Splits the taxable base across the configured counties, stamps the per-county
 * receipts (as computed `county_${code}_receipts` fields so the shared
 * derivation is self-contained from the worksheet alone), then delegates ALL
 * tax math — per-line tax, page-2 county rows, dependent totals — to the single
 * `deriveNcDorFigures` used identically by the server merge and the client
 * live-recompute. See file header.
 */
export function computeNcDorFigures(
  args: ComputeNcDorFiguresArgs,
  rateMap: Record<string, number>,
): WorksheetData {
  const { taxableBaseCents, counties, collectedGeneralTaxCents } = args;
  const warnings: string[] = [];

  const fields: WorksheetFields = {
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

  // Line 4 — state tax applies to the full base.
  fields.line4_receipts = taxableBaseCents;

  // Validate the configured weights (Hamilton split stays exact regardless).
  const totalWeight = counties.reduce((s, c) => s + c.weight, 0);
  if (counties.length > 0 && totalWeight !== 100) {
    warnings.push(
      `Configured county weights sum to ${totalWeight}, not 100. Base was apportioned proportionally — review the county configuration.`,
    );
  }

  const bases = allocateByWeights(
    taxableBaseCents,
    counties.map((c) => c.weight),
  );

  counties.forEach((county, i) => {
    const code = county.code;
    const countyBase = bases[i];

    // Always initialise the page-2 rows for a selected county.
    fields[`county_${code}_2pct`] = 0;
    fields[`county_${code}_225pct`] = 0;
    fields[`county_${code}_transit`] = 0;

    if (!KNOWN_COUNTY_CODES.has(code)) {
      warnings.push(`Unknown county code "${code}" — its receipts were not taxed. Check the county configuration.`);
      return;
    }
    const tier = { local: rateMap[ncLocalKey(code)] ?? 0, transit: rateMap[ncTransitKey(code)] ?? 0 };

    // Stamp this county's receipts so the shared derivation can split any
    // manual per-line purchases across counties by the same receipts weights.
    fields[`county_${code}_receipts`] = countyBase;

    // Page-1 receipts aggregation: line receipts are the SUM of county bases.
    const localLine = countyRateLine(tier.local); // '9' | '10'
    fields[`line${localLine}_receipts`] = num(fields[`line${localLine}_receipts`]) + countyBase;

    const transitLine = transitRateLine(tier.transit); // '11' | '12' | null
    if (transitLine) {
      fields[`line${transitLine}_receipts`] = num(fields[`line${transitLine}_receipts`]) + countyBase;
    }
  });

  // All tax math (per-line tax, page-2 county rows, dependent totals) via the
  // single shared derivation — purchases are 0 here, so this is a pure compute.
  const derived = deriveNcDorFigures(fields, rateMap);

  // Reconciliation: computed total general tax (L13) vs Square-collected.
  // Square rounds tax per transaction while this engine computes on the
  // aggregate monthly base, so a normal month drifts by tens of cents with NO
  // rate misconfiguration — that's expected rounding noise, not a bug. The
  // warning exists to catch a misconfigured rate/tier, which produces a large
  // *proportional* error, not a fixed few cents. Tolerance = 0.1% of collected
  // tax, floored at 100¢, so ordinary rounding drift never fires the warning
  // while a genuine rate/tier misconfiguration still does.
  const tolerance = Math.max(100, Math.round(collectedGeneralTaxCents * 0.001));
  const line13Total = num(derived.line13_total);
  const diff = Math.abs(line13Total - collectedGeneralTaxCents);
  if (diff > tolerance) {
    warnings.push(
      `Computed general sales tax (${line13Total}¢) differs from Square-collected (${collectedGeneralTaxCents}¢) by ${diff}¢, exceeding the ${tolerance}¢ rounding tolerance. Review before filing.`,
    );
  }

  const result: WorksheetData = {
    fields: derived,
    meta: { computedAt: new Date().toISOString(), provenance: "square" },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
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
  const [{ baseCents, collectedCents }, rateMap] = await Promise.all([
    fetchTaxableBase(client, generalSalesTaxId, ctx.period),
    listTaxRates(client).then(buildRateMap),
  ]);

  return computeNcDorFigures(
    {
      taxableBaseCents: baseCents,
      counties,
      collectedGeneralTaxCents: collectedCents,
    },
    rateMap,
  );
}
