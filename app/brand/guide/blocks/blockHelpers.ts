/**
 * Pure helpers behind the guide blocks.
 *
 * Extracted so they can be tested: vitest runs in a `node` environment with no
 * DOM testing library, so rendering assertions aren't available. Anything in a
 * block worth asserting lives here.
 */

/** Where the quarter-point tick marks sit on a calibration track. */
export function sliderTicks(): number[] {
  return [0, 25, 50, 75, 100];
}

/**
 * A slider position constrained to the track, as a whole number.
 *
 * Canon values are admin-entered, so a value outside 0–100 is reachable and
 * must not push the dot outside its track. A non-finite value falls back to the
 * midpoint rather than rendering `NaN%` into a style attribute.
 */
export function clampPos(pos: number): number {
  if (Number.isNaN(pos)) return 50;
  return Math.round(Math.min(100, Math.max(0, pos)));
}
