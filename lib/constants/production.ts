export const GALLONS_PER_BBL = 31;
export const FL_OZ_PER_GALLON = 128;
export const BBL_TO_FL_OZ   = 3968; // 1 bbl = 31 gal = 3968 fl oz

export type KegSize = "half" | "quarter" | "sixth";

/**
 * Physical keg-size -> FL OZ table. THE source of truth for keg capacity in
 * TypeScript, and it must agree with `packaging_items.volume_fl_oz` in the
 * database — those rows are the same physical containers.
 *
 * Fl oz, not gallons, is the base unit because every stored volume in the app
 * is fl oz (packaging_items, packaging_variations, square_catalog_variations,
 * cold_storage_transforms). Gallons used to be the base here, and the sixtel's
 * 5.167 gal rounded to 661.376 fl oz — a third figure for a keg the database
 * calls 661. Deriving gallons from fl oz means one number per container, and
 * a sixtel is now 5.1640625 gal.
 *
 * A true sixth barrel is 31/6 = 5.1667 gal = 661.33 fl oz; 661 is the whole-oz
 * figure the database stores. If that canonical figure ever changes, change it
 * HERE and in `packaging_items` together — nothing else hardcodes it.
 */
export const KEG_FL_OZ_BY_SIZE: Record<KegSize, number> = {
  half: 1984,
  quarter: 992,
  sixth: 661,
};

// Derived from the fl-oz table above so the two can never disagree. Consumers:
// lib/reports/bbl-tracker.ts (keyed by "1/2 Keg" etc. label strings) and
// lib/finance/financials/volume.ts (keyed by the size-token enum used
// elsewhere in lib/finance).
export const KEG_GALLONS_BY_SIZE: Record<KegSize, number> = {
  half:    KEG_FL_OZ_BY_SIZE.half / FL_OZ_PER_GALLON,
  quarter: KEG_FL_OZ_BY_SIZE.quarter / FL_OZ_PER_GALLON,
  sixth:   KEG_FL_OZ_BY_SIZE.sixth / FL_OZ_PER_GALLON,
};

// Brew Status grid — quarter-cell resolution: each visual square from the
// previous 48px/24-col/16-row grid is now 4 placement cells (2x2).
export const GRID_CELL_PX = 24;
export const GRID_GAP_PX  = 2;
export const GRID_COLS    = 48;
export const GRID_ROWS    = 32;
