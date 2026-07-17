/**
 * Wake County — Prepared Food & Beverage Tax — calculation engine.
 *
 *  - computeWakeFigures      — pure worksheet builder: tax owed = round(
 *    applicable receipts x rate), plus a reconciliation warning when the
 *    computed tax diverges from what Square actually collected on the F&B line.
 *  - computeWakeWorksheet    — glue: reads the two Square tax ids from the
 *    profile, pulls each base via the shared fetchTaxableBase, reads the rate
 *    from tax_rates (statutory 1% fallback), and assembles the field set.
 *
 * Gross Receipts uses the SAME logic as NC DOR Sales & Use (net_sales - tax on
 * the general sales tax line); it is display-only and never reconciled. Only
 * the F&B line is reconciled. All money is integer cents; the single rounding
 * is Math.round on the tax-owed line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { getTaxRate } from "@/lib/tax/rates";
import { fetchTaxableBase } from "@/lib/tax/squareTaxBase";
import { WAKE_FB_RATE_KEY, WAKE_FB_RATE_FALLBACK } from "./rates";

export interface ComputeWakeFiguresArgs {
  grossReceiptsCents: number | null; // null when general_sales_tax_id is unset
  applicableReceiptsCents: number;
  collectedFbCents: number;
  rate: number; // e.g. 0.01
}

export function computeWakeFigures(args: ComputeWakeFiguresArgs): WorksheetData {
  const { grossReceiptsCents, applicableReceiptsCents, collectedFbCents, rate } = args;
  const warnings: string[] = [];

  const taxOwedCents = Math.round(applicableReceiptsCents * rate);

  const fields: WorksheetFields = {
    wake_gross_receipts_cents: grossReceiptsCents,
    wake_applicable_receipts_cents: applicableReceiptsCents,
    wake_tax_owed_cents: taxOwedCents,
    wake_collected_fb_cents: collectedFbCents,
    wake_rate: rate,
  };

  // Reconciliation (F&B line only): Square rounds tax per transaction while
  // this computes on the aggregate monthly base, so a normal month drifts by a
  // few cents with no misconfiguration. Tolerance = 0.1% of collected, floored
  // at 100 cents, so ordinary rounding never fires while a genuine mismatch does.
  const tolerance = Math.max(100, Math.round(collectedFbCents * 0.001));
  const diff = Math.abs(taxOwedCents - collectedFbCents);
  if (diff > tolerance) {
    warnings.push(
      `Computed Wake County tax (${taxOwedCents}¢) differs from Square-collected (${collectedFbCents}¢) by ${diff}¢, exceeding the ${tolerance}¢ rounding tolerance. Review before filing.`,
    );
  }

  const result: WorksheetData = {
    fields,
    meta: { computedAt: new Date().toISOString(), provenance: "square" },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export async function computeWakeWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
): Promise<WorksheetData> {
  const foodBeverageTaxId = ctx.profile.food_beverage_tax_id;
  const generalSalesTaxId = ctx.profile.general_sales_tax_id;

  if (!foodBeverageTaxId) {
    return {
      fields: {},
      warnings: [
        "No Square Prepared Food & Beverage Tax configured (profile.food_beverage_tax_id is empty). Set it in Tax settings before recomputing.",
      ],
      meta: { computedAt: new Date().toISOString(), provenance: "square" },
    };
  }

  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [applicable, gross, rateFromDb] = await Promise.all([
    fetchTaxableBase(client, foodBeverageTaxId, ctx.period),
    generalSalesTaxId ? fetchTaxableBase(client, generalSalesTaxId, ctx.period) : Promise.resolve(null),
    getTaxRate(client, WAKE_FB_RATE_KEY),
  ]);

  const rate =
    rateFromDb != null && Number.isFinite(rateFromDb) && rateFromDb > 0 ? rateFromDb : WAKE_FB_RATE_FALLBACK;

  const result = computeWakeFigures({
    grossReceiptsCents: gross ? gross.baseCents : null,
    applicableReceiptsCents: applicable.baseCents,
    collectedFbCents: applicable.collectedCents,
    rate,
  });

  if (rateFromDb == null) {
    result.warnings = [
      `No active Wake County food & beverage rate configured — using the statutory fallback (${(WAKE_FB_RATE_FALLBACK * 100).toFixed(2)}%). Set the rate in the tax_rates registry.`,
      ...(result.warnings ?? []),
    ];
  }

  return result;
}
