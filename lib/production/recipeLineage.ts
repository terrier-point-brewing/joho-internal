/**
 * Recipe lineage — a derived recipe and the base it converts from.
 *
 * `recipes.base_recipe_id` records that a beer is normally made by converting
 * another one: Orange Pilsner is Pace Yourself Pilsner plus oranges. The derived
 * recipe still stores its COMPLETE bill, because brewing it from scratch is a
 * legitimate thing to do and every downstream reader (costing, deposit
 * reconstruction, inventory-on-hand) needs the whole thing. What the link buys
 * is the ability to answer a second question — "what does the conversion add?" —
 * which is the difference between the two bills.
 */

/** One ingredient line of a bill, at the finished-liquid rate. */
export interface BillLine {
  ingredient_id: string;
  /** quantity_per_bbl — quantity_per_turn ÷ the recipe's expected yield. */
  quantity_per_bbl: number;
}

/** Below this, a difference is float noise from the per-bbl division, not an addition. */
const EPSILON = 1e-9;

function totalsByIngredient(lines: BillLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const l of lines) {
    const qty = Number(l.quantity_per_bbl);
    if (!Number.isFinite(qty)) continue;
    totals.set(l.ingredient_id, (totals.get(l.ingredient_id) ?? 0) + qty);
  }
  return totals;
}

/**
 * What a conversion from `base` into `derived` actually adds, per bbl.
 *
 * Rates, not per-turn quantities: a conversion draws a volume of finished
 * liquid, not a brewhouse turn, and the two recipes may not even declare the
 * same expected yield. quantity_per_bbl is the common denominator.
 *
 * An ingredient the derived recipe uses LESS of than its base — or drops
 * entirely — contributes nothing rather than a negative. The base's grain is
 * already dissolved in the liquid being drawn off; a conversion can add to a
 * batch but it cannot take malt back out, so a credit here would reserve
 * negative stock for something that physically happened.
 */
export function conversionDelta(derived: BillLine[], base: BillLine[]): BillLine[] {
  const baseTotals = totalsByIngredient(base);
  const delta: BillLine[] = [];

  for (const [ingredient_id, qty] of totalsByIngredient(derived)) {
    const added = qty - (baseTotals.get(ingredient_id) ?? 0);
    if (added > EPSILON) delta.push({ ingredient_id, quantity_per_bbl: added });
  }

  return delta;
}

/**
 * Split a derived recipe's bill for display: which lines the base already
 * contributes, and which the conversion adds.
 *
 * `inherited` is every line whose ingredient the base also carries — the
 * conversion does not buy these again. `added` is everything else, plus any line
 * the derived recipe genuinely increases. A line is never in both.
 */
export function splitBillAgainstBase<T extends { ingredient_id: string; quantity_per_bbl: number }>(
  derivedLines: T[],
  baseLines: BillLine[],
): { inherited: T[]; added: T[] } {
  const baseTotals = totalsByIngredient(baseLines);
  const inherited: T[] = [];
  const added: T[] = [];

  for (const line of derivedLines) {
    const baseQty = baseTotals.get(line.ingredient_id);
    if (baseQty == null) added.push(line);
    else if (Number(line.quantity_per_bbl) - baseQty > EPSILON) added.push(line);
    else inherited.push(line);
  }

  return { inherited, added };
}

// ─── Lineage chains ───────────────────────────────────────────────────────────
// Lineage used to stop after one step, because "the difference against the base"
// looked ambiguous once a chain existed. It isn't: a conversion always measures
// against the recipe of the batch it is actually drawn off, and because every
// bill is COMPLETE and every conversion only adds, the arithmetic composes.
//
//   Pace Yourself Pilsner  →  Carolina Mule  →  Transfusion Lager
//                          (+ ginger, lime)   (+ grape juice)
//
// Drawing Transfusion off a Mule batch charges the grape juice. Drawing it
// straight off a Pilsner batch charges ginger + lime + grape juice. Both are
// right, and both fall out of the same subtraction — so a chain needs no special
// case, only a guard against a cycle.

/** Hard stop when walking a chain. A longer one is a data bug, not a beer. */
export const MAX_LINEAGE_DEPTH = 20;

/**
 * Every recipe this one is converted from, nearest base first.
 *
 * Self-limiting: a cycle (which the DB trigger rejects, but old rows or a
 * partial fetch could still present) stops at the first repeat rather than
 * spinning.
 */
export function lineageAncestors(
  recipeId: string,
  baseById: ReadonlyMap<string, string | null>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([recipeId]);

  let cursor = baseById.get(recipeId) ?? null;
  while (cursor && !seen.has(cursor) && chain.length < MAX_LINEAGE_DEPTH) {
    chain.push(cursor);
    seen.add(cursor);
    cursor = baseById.get(cursor) ?? null;
  }
  return chain;
}

/** True when `ancestorId` appears anywhere above `recipeId` in the chain. */
export function isDerivedFrom(
  recipeId: string,
  ancestorId: string,
  baseById: ReadonlyMap<string, string | null>,
): boolean {
  return lineageAncestors(recipeId, baseById).includes(ancestorId);
}

/**
 * Every recipe that converts from this one, at any depth.
 *
 * What a conversion off a batch of `recipeId` may legitimately produce, and —
 * inverted — the set a recipe may never be based on, since that would close a
 * cycle.
 */
export function lineageDescendants(
  recipeId: string,
  baseById: ReadonlyMap<string, string | null>,
): Set<string> {
  const out = new Set<string>();
  for (const id of baseById.keys()) {
    if (id !== recipeId && isDerivedFrom(id, recipeId, baseById)) out.add(id);
  }
  return out;
}

/** Build the id → base_recipe_id map the walkers read, from any recipe rows. */
export function baseMapOf(
  recipes: ReadonlyArray<{ id: string; base_recipe_id?: string | null }>,
): Map<string, string | null> {
  return new Map(recipes.map((r) => [r.id, r.base_recipe_id ?? null]));
}
