import { SupabaseClient } from "@supabase/supabase-js";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import { centsToDollars, dollarsToCents } from "@/lib/money";

export interface ExciseTaxLine {
  rateId: string | null;
  name: string;
  unit: "bbl" | "gallon";
  rateUsd: number;
  amountUsd: number;
}

/**
 * Computes the excise tax breakdown for a given volume by applying every
 * active excise_tax_rates row. Replaces the old hardcoded
 * FEDERAL_EXCISE_PER_BBL/NC_EXCISE_PER_GAL constants — any number of taxes
 * can apply, configured entirely via the excise_tax_rates table.
 */
export async function computeExciseTaxBreakdown(supabase: SupabaseClient, volumeBbl: number): Promise<ExciseTaxLine[]> {
  const { data: rates } = await supabase
    .from("excise_tax_rates")
    .select("id, name, unit, rate_usd")
    .eq("is_active", true);

  return (rates ?? []).map((r) => {
    const units = r.unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
    // UNIT CROSSING: rate_usd is a decimal USD rate; snap the computed amount to
    // whole cents (dollars → cents → dollars) so the stored figure is cent-exact.
    // The rate math itself stays in decimal dollars.
    const amountUsd = centsToDollars(dollarsToCents(r.rate_usd * units));
    return { rateId: r.id, name: r.name, unit: r.unit as "bbl" | "gallon", rateUsd: r.rate_usd, amountUsd };
  });
}
