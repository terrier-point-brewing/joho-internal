/**
 * Ingredient unit arithmetic.
 *
 * The VOCABULARY — which units an ingredient may be measured in — lives in the
 * `ingredient_units` table and reaches the app through
 * /api/production/ingredient-units. This module does not duplicate it.
 *
 * What lives here is the two things a table row cannot be:
 *
 *   • normalizeUnit / ouncesPerUnit — matching what a human TYPED against a
 *     known weight, for the legacy free-text values that predate the
 *     vocabulary and for callers (freight allocation) that receive a bare
 *     string. Deliberately a superset: "pound", "#", "kg" are recognized here
 *     and are not, and should not become, offerable units.
 *
 *   • conversionRatio — the arithmetic a unit change rests on. Postgres owns
 *     the authoritative copy inside convert_ingredient_unit(); this one drives
 *     the preview the operator confirms, so the two must agree.
 *
 * Packaging and produced inventory are out of scope. Their unit semantics live
 * in lib/square/catalogUnits.ts and the fl-oz volume ledger — do not route
 * either one through here without deciding what a "unit" means over there.
 */

export type UnitDimension = "weight" | "volume" | "count";

/** One row of the `ingredient_units` vocabulary. */
export interface IngredientUnit {
  code: string;
  label: string;
  dimension: UnitDimension;
  /** Base units (oz for weight, fl oz for volume) in one of this unit; null = no fixed conversion. */
  base_factor: number | null;
  is_active: boolean;
  sort_order: number;
}

/**
 * Ounces per 1 unit, keyed by normalized string. Used for ONE purpose:
 * apportioning a shipment's freight across its lines by weight. It is never a
 * conversion factor — that is `base_factor` on the vocabulary row, and the two
 * are deliberately allowed to disagree.
 *
 * Everything above the divider is a physical constant and matches the
 * `base_factor` the migration seeds for the corresponding code. The extra keys
 * there are just spellings a human might type.
 *
 * `bricks` below the divider is different, and the distinction matters. A dry
 * yeast brick is conventionally 500 g, which is a fact about how the industry
 * packages yeast rather than about the unit — a brick of something else could
 * weigh anything. That is enough to split a freight bill fairly and NOT enough
 * to restate someone's stock, so `bricks` keeps `base_factor = null` in the
 * vocabulary and stays unconvertible. Weighing a shipment is an estimate by
 * nature; rewriting an inventory figure is not.
 */
const OZ_PER_UNIT: Record<string, number> = {
  oz: 1, ounce: 1, ounces: 1,
  lb: 16, lbs: 16, pound: 16, pounds: 16, "#": 16,
  g: 0.035274, gram: 0.035274, grams: 0.035274,
  kg: 35.274, kilogram: 35.274, kilograms: 35.274,

  // Conventional packaging weights, for freight apportionment only.
  brick: 17.637, bricks: 17.637,   // 500 g dry yeast brick
};

/** Lowercase, trim, drop a trailing period. `"Lbs."` and `" LBS "` are both `lbs`. */
export function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.$/, "");
}

/** Ounces in one of `unit`, or null when it names no known weight. */
export function ouncesPerUnit(unit: string): number | null {
  return OZ_PER_UNIT[normalizeUnit(unit)] ?? null;
}

/**
 * How many `to` there are in one `from`, given the vocabulary.
 *
 * Null — never a silent 1 — whenever the conversion would be a guess: an
 * unknown code, a unit with no fixed factor (a yeast brick's weight is a fact
 * about the yeast, not about the unit), or two different dimensions. Pounds to
 * liters has no answer without a density nobody has recorded.
 */
export function conversionRatio(
  fromCode: string,
  toCode: string,
  vocabulary: IngredientUnit[],
): number | null {
  const from = vocabulary.find((u) => u.code === fromCode);
  const to = vocabulary.find((u) => u.code === toCode);
  if (!from || !to) return null;
  if (from.dimension !== to.dimension) return null;
  if (from.base_factor == null || to.base_factor == null) return null;
  if (to.base_factor === 0) return null;
  return from.base_factor / to.base_factor;
}

/**
 * The units `fromCode` can actually be converted into: same dimension, both
 * sides carry a factor, still offerable, and not itself.
 */
export function convertibleTargets(
  fromCode: string,
  vocabulary: IngredientUnit[],
): IngredientUnit[] {
  return vocabulary.filter(
    (u) => u.code !== fromCode && u.is_active && conversionRatio(fromCode, u.code, vocabulary) != null,
  );
}

/**
 * What a conversion would do to one ingredient's numbers.
 *
 * Quantities scale by the ratio and a per-unit cost scales by its inverse, so
 * quantity x cost is unchanged. A conversion restates numbers; it must never
 * move value. Mirrors convert_ingredient_unit() so the preview an operator
 * confirms is the write that follows.
 */
export interface ConversionPreview {
  ratio: number;
  stock_quantity: number;
  cost_per_unit_usd: number | null;
}

export function previewConversion(
  current: { stock_quantity: number; cost_per_unit_usd: number | null },
  ratio: number,
): ConversionPreview {
  return {
    ratio,
    stock_quantity: current.stock_quantity * ratio,
    cost_per_unit_usd:
      current.cost_per_unit_usd == null ? null : current.cost_per_unit_usd / ratio,
  };
}

/**
 * Postgres speaks in constraint names; the operator needs a sentence. Both
 * cases come from the ingredient-unit vocabulary:
 *
 *   42501 — ingredients_guard_unit_change fired. The unit has stock, recipes
 *           or history behind it, so changing it is a conversion, not an edit.
 *   23503 — ingredients_unit_fkey. A unit outside the vocabulary was sent,
 *           which now only reaches the API from a stale client.
 *
 * Returns null for anything else, so callers fall through to their own
 * handling rather than mislabelling an unrelated failure.
 */
export function describeUnitError(err: { code?: string; message: string }): string | null {
  if (err.code === "42501" && err.message.includes("unit")) {
    return `${err.message} Open the ingredient and use "Change unit & convert".`;
  }
  if (err.code === "23503" && err.message.includes("ingredients_unit_fkey")) {
    return "That unit is not one of the available ingredient units. Reload the page and pick one from the list.";
  }
  return null;
}
