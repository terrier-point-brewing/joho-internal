/**
 * Every string a partner reads on a generated Square invoice (or on the
 * refund that reverses one), in one place.
 *
 * House rules: name the beer, the batch or the company and nothing else.
 * Shares, volumes, yields, rates and exclusions stay in the ledger and the
 * operator modals — a number on an invoice reads as a promise, and the
 * derivation changes with shrinkage. Nothing here prints a percentage with
 * decimals or a bbl figure; invoiceCustomerText.test.ts enforces that.
 */

import { INGREDIENT_COST_PREFIX } from "@/lib/production/depositLine";

// ── Invoice titles / descriptions ────────────────────────────────────────────

export function exportInvoiceTitle(companyName: string): string {
  return `Export Invoice — ${companyName}`;
}

export function depositInvoiceTitle(beerName: string): string {
  return `Ingredient Deposit — ${beerName}`;
}

export function depositInvoiceDescription(beerName: string): string {
  return `Ingredient deposit for your ${beerName} batch.`;
}

// ── Line items ───────────────────────────────────────────────────────────────

/** The deposit invoice's single line. Bills against the Square "Ingredient Deposit" item. */
export const DEPOSIT_LINE_DESCRIPTION = "Ingredient Deposit";

/**
 * The ingredient-share line on an export invoice. "Ingredient Cost", not
 * "Deposit": to the partner it is the cost of ingredients in beer they have
 * received. The prefix is load-bearing — isIngredientDepositLine matches it.
 * The shipped volume is deliberately absent; it lives in the breakdown modal.
 */
export function ingredientCostLineDescription(beerName: string, batchNumber: string | null | undefined): string {
  const batch = batchNumber ? ` (batch ${batchNumber})` : "";
  return `${INGREDIENT_COST_PREFIX} — ${beerName.trim()}${batch}`;
}

/** Packaging Fee lines carry the beer so a multi-recipe invoice is unambiguous. */
export function packagingFeeLineDescription(displayName: string, beerName: string | null | undefined): string {
  return beerName ? `${displayName} — ${beerName}` : displayName;
}

export function packagingMaterialsLineDescription(beerName: string | null | undefined): string {
  return beerName ? `Packaging Materials — ${beerName}` : "Packaging Materials";
}

/**
 * Excise is a statutory pass-through, one line per receiving party (Federal,
 * NC) because each bills against its own Square item. The taxed volume stays
 * on the tax record and the ledger, not on the customer's line.
 */
export function exciseTaxLineDescription(receivingParty: string): string {
  return `Excise Tax — ${receivingParty}`;
}

/** A shipped product the catalog already knows: Square's own item + variation names. */
export function catalogProductLineDescription(
  itemName: string | null | undefined,
  variationName: string | null | undefined,
  packagingFormat: string | null | undefined,
  fallback: string,
): string {
  if (!itemName) return fallback;
  return `${itemName}${variationName ? ` · ${variationName}` : ""}${packagingFormat ? ` (${packagingFormat})` : ""}`;
}

/** A shipped product with no catalog item yet: beer · variant (format). */
export function unmappedProductLineDescription(
  beerName: string | null | undefined,
  variantLabel: string,
  packagingFormat: string | null | undefined,
): string {
  return `${beerName ? `${beerName} · ` : ""}${variantLabel}${packagingFormat ? ` (${packagingFormat})` : ""}`;
}

// ── Refunds ──────────────────────────────────────────────────────────────────

/** Reason text Square shows the customer when a paid deposit is partly refunded. */
export const DEPOSIT_REDUCED_REFUND_REASON = "Deposit adjusted — allocation reduced";
