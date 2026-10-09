/**
 * Recognise the ingredient-share line on an export invoice by its text.
 *
 * The line is drafted as "Ingredient Cost — …": to the partner it is the cost
 * of the ingredients in the beer on that invoice, not a deposit against a
 * future one. It still bills against the Square "Ingredient Deposit" item, and
 * invoices drafted before the rename say "Ingredient Deposit", so both match.
 * Catalog-backed only — a free-text line that happens to use the words is not
 * the system's charge.
 */
export const INGREDIENT_COST_PREFIX = "Ingredient Cost";

export function isIngredientDepositLine(li: { description: string; squareCatalogVariationId?: string | null }): boolean {
  return li.squareCatalogVariationId != null && /ingredient (deposit|cost)/i.test(li.description);
}
