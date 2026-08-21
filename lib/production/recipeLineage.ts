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
