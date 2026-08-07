/**
 * Single source of truth for "how much volume does one sold unit of a Square
 * variation represent" and "is this variation counted by fluid ounce or by
 * each". Replaces the per-feature name-parsers (sell-through's ozPerSale).
 *
 * lib/reports/bbl-tracker.ts's canOzPerUnit intentionally stays separate for
 * now (reports are out of scope for the mapping consolidation) — do not import
 * this from there yet.
 */

import { KEG_FL_OZ_BY_SIZE } from "@/lib/constants/production";

export type InventoryUnit = "fl_oz" | "each";

// Keyed by the size token as it appears in a Square variation name. The volumes
// themselves come from lib/constants/production.ts — this table only maps a
// name fragment onto a keg size, it does not get its own copy of the capacity.
const KEG_FL_OZ: Record<string, number> = {
  "1/2 Keg": KEG_FL_OZ_BY_SIZE.half,
  "1/4 Keg": KEG_FL_OZ_BY_SIZE.quarter,
  "1/6 Keg": KEG_FL_OZ_BY_SIZE.sixth,
};

const KEG_NAME = /\b(1\/2|1\/4|1\/6)\s*Keg\b/i;
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*oz/i;
const PACK_TOKEN = /(\d+)[\s-]?(?:pack|pk)\b/i;
const CASE_TOKEN = /\bcase\b/i;

/** Total fluid ounces one sold unit of this variation represents, or null if unknown. */
export function volumeFlOzPerUnit(variationName: string | null): number | null {
  if (!variationName) return null;

  const kegMatch = variationName.match(KEG_NAME);
  if (kegMatch) {
    const key = `${kegMatch[1]} Keg`;
    return KEG_FL_OZ[key] ?? null;
  }

  const sizeMatch = variationName.match(SIZE_TOKEN);
  if (!sizeMatch) return null;
  const oz = parseFloat(sizeMatch[1]);

  if (CASE_TOKEN.test(variationName)) return 24 * oz;
  const packMatch = variationName.match(PACK_TOKEN);
  if (packMatch) return parseInt(packMatch[1], 10) * oz;
  return oz;
}

/** Whether Square tracks stock for this variation by fluid ounce or by each. */
export function inferInventoryUnit(variationName: string | null): InventoryUnit | null {
  if (!variationName) return null;
  if (KEG_NAME.test(variationName)) return "each";
  if (SIZE_TOKEN.test(variationName) || PACK_TOKEN.test(variationName) || CASE_TOKEN.test(variationName)) {
    return "each";
  }
  // Bare base variation (no size/pack token) — the fl-oz-tracked draft base.
  return "fl_oz";
}
