export const GALLONS_PER_BBL = 31;
export const BBL_TO_FL_OZ   = 3968; // 1 bbl = 31 gal = 3968 fl oz

// Physical keg-size -> gallons table. Canonical home for this constant —
// consumers: lib/reports/bbl-tracker.ts (keyed by "1/2 Keg" etc. label
// strings) and lib/finance/financials/volume.ts (keyed by the "half" |
// "quarter" | "sixth" size-token enum used elsewhere in lib/finance).
export const KEG_GALLONS_BY_SIZE: Record<"half" | "quarter" | "sixth", number> = {
  half: 15.5,
  quarter: 7.75,
  sixth: 5.167,
};

// Brew Status grid — quarter-cell resolution: each visual square from the
// previous 48px/24-col/16-row grid is now 4 placement cells (2x2).
export const GRID_CELL_PX = 24;
export const GRID_GAP_PX  = 2;
export const GRID_COLS    = 48;
export const GRID_ROWS    = 32;
