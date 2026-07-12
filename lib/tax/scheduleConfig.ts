/**
 * Pure validation for a tax schedule's county-weight config — the shape
 * `{ counties: { code, weight }[] }` stored in `tax_schedules.config` for the
 * NC DOR Sales & Use party (see `scheduleConfigSchema` in
 * lib/tax/parties/ncDorSalesUse/template.ts). Kept free of React/Supabase so
 * it's trivially unit-testable and reusable anywhere a schedule's county
 * config needs validating (editor UI today; a server-side guard later).
 */
export interface CountyWeight {
  code: string;
  weight: number;
}

const WEIGHT_SUM_TOLERANCE = 0.01;
const EXPECTED_WEIGHT_SUM = 100;

/**
 * Validates a schedule's `config.counties` array: at least one county, every
 * weight a non-negative finite number, and the weights summing to 100
 * (within floating-point tolerance). Returns an error message describing the
 * first problem found, or `null` if the set is valid.
 */
export function validateCountyWeights(counties: CountyWeight[]): string | null {
  if (!counties || counties.length === 0) {
    return "Select at least one county.";
  }

  for (const county of counties) {
    if (!Number.isFinite(county.weight) || county.weight < 0) {
      return `Weight for ${county.code} must be a non-negative number.`;
    }
  }

  const sum = counties.reduce((total, county) => total + county.weight, 0);
  if (Math.abs(sum - EXPECTED_WEIGHT_SUM) > WEIGHT_SUM_TOLERANCE) {
    return `County weights must sum to 100% (currently ${sum.toFixed(2)}%).`;
  }

  return null;
}
