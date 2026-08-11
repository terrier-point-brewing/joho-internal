/**
 * Pure validation for a tax schedule's config blobs stored in
 * `tax_schedules.config`. Two shapes today:
 *
 *   - `{ counties: { code, weight }[] }` for NC DOR Sales & Use;
 *   - `{ <key>: string[] }` for any party declaring a `"multiselect"` field in
 *     its `scheduleConfigSchema` (e.g. Wake County Beer & Wine's license types).
 *
 * Kept free of React/Supabase so it's trivially unit-testable.
 */

/** Reads a `"multiselect"` config value, keeping only values the field offers. */
export function readMultiSelect(
  config: Record<string, unknown> | undefined,
  key: string,
  allowedValues: string[],
): string[] {
  const raw = config?.[key];
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedValues);
  const seen = new Set<string>();
  return raw
    .map((entry) => String(entry))
    .filter((value) => allowed.has(value) && !seen.has(value) && (seen.add(value), true));
}

/** `null` when the selection is acceptable, else the problem to show the operator. */
export function validateMultiSelect(
  label: string,
  required: boolean | undefined,
  selected: string[],
): string | null {
  if (required && selected.length === 0) return `Select at least one option for ${label}.`;
  return null;
}

/**
 * The NC DOR Sales & Use county-weight shape (see `scheduleConfigSchema` in
 * lib/tax/parties/ncDorSalesUse/template.ts).
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
