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

// The app's ONE story about volume slack.
//
// packaging_variations.total_volume_fl_oz is recorded in whole fluid ounces
// everywhere, but not every container holds a whole number of them: a 1/2 bbl is
// exactly 1984 fl oz and a 1/4 bbl exactly 992, but a 1/6 bbl is 31/6 gal =
// 661.33 fl oz and we store 661. So a stored volume can understate or overstate
// the real container by up to half a fluid ounce, and a comparison of stored
// volumes carries that error ONCE PER UNIT — it accumulates, it does not cancel.
//
// Today the sixtel is the only inexact container in the set — see
// KEG_FL_OZ_BY_SIZE above, where 661 is the stored figure against a true 661.33,
// while every can, pack, case, 1/4 and 1/2 keg is exact. So 0.5 is a bound with
// headroom rather than a tight fit. It is deliberately sized from the storage
// format instead of from today's sizes, so a future variation whose true volume
// isn't a whole ounce needs no special case.
//
// This is the OTHER half of the answer to the sixtel. KEG_FL_OZ_BY_SIZE settles
// which single number the app stores (661, whole ounces); this settles how much
// slack a comparison of those stored numbers has to carry. Neither works alone:
// rounding to a whole ounce is only safe because arithmetic on it is tolerant.
//
// Consumers: lib/production/coldStorageTransform.ts and the DB constraint it
// mirrors (cold_storage_transforms_never_creates_volume). Related but NOT the
// same number: SWAP_VOLUME_TOLERANCE_FL_OZ in phantomExportAlerts.ts is a flat
// per-keg 5 fl oz because it asks "is this the same size keg?" of ONE unit,
// where sizes are 331 fl oz apart and a generous flat slack is safe.
export const VOLUME_ROUNDING_SLACK_PER_UNIT_FL_OZ = 0.5;

// Brew Status grid — quarter-cell resolution: each visual square from the
// previous 48px/24-col/16-row grid is now 4 placement cells (2x2).
export const GRID_CELL_PX = 24;
export const GRID_GAP_PX  = 2;
export const GRID_COLS    = 48;
export const GRID_ROWS    = 32;
