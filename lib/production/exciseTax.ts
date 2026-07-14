import { SupabaseClient } from "@supabase/supabase-js";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { listTaxRates, type TaxRate } from "@/lib/tax/rates";

export interface ExciseTaxLine {
  rateId: string | null;
  name: string;
  unit: "bbl" | "gallon";
  rateUsd: number;
  amountUsd: number;
}

/** Maps a `tax_rates.basis` value to the output `ExciseTaxLine.unit` shape. */
const UNIT_BY_BASIS: Record<TaxRate["basis"], "bbl" | "gallon"> = {
  per_bbl: "bbl",
  per_gallon: "gallon",
  // Excise rows are always per_bbl/per_gallon; percent never occurs in
  // category='excise', but fall back to the gallon-conversion branch (same
  // as the legacy "anything not 'bbl'" behavior) rather than throwing.
  percent: "gallon",
};

/**
 * Computes the excise tax breakdown for a given volume by applying every
 * active `tax_rates` row in category `excise`. Replaces the old hardcoded
 * FEDERAL_EXCISE_PER_BBL/NC_EXCISE_PER_GAL constants — any number of taxes
 * can apply, configured entirely via the canonical `tax_rates` table.
 */
export async function computeExciseTaxBreakdown(supabase: SupabaseClient, volumeBbl: number): Promise<ExciseTaxLine[]> {
  const rates = await listTaxRates(supabase, { category: "excise", activeOnly: true });

  return rates.map((r) => {
    const unit = UNIT_BY_BASIS[r.basis];
    const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
    // UNIT CROSSING: rate is a decimal USD rate; snap the computed amount to
    // whole cents (dollars → cents → dollars) so the stored figure is cent-exact.
    // The rate math itself stays in decimal dollars.
    const amountUsd = centsToDollars(dollarsToCents(r.rate * units));
    return { rateId: r.id, name: r.name, unit, rateUsd: r.rate, amountUsd };
  });
}
