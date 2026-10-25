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
import { GALLONS_PER_BBL } from "@/lib/constants/production";

// ── Invoice titles / descriptions ────────────────────────────────────────────

export function exportInvoiceTitle(companyName: string): string {
  return `Export Invoice — ${companyName}`;
}

export function depositInvoiceTitle(beerName: string): string {
  return `Ingredient Deposit — ${beerName}`;
}

/** What the partner is buying a share of. `projectedYieldBbl` is the WHOLE batch's projected yield. */
export interface DepositShare {
  sharePct: number;
  batchNumber: string;
  turns: number;
  beerName: string;
  /** The share basis (lib/production/batchYieldProjection.server shareBasisBbl) — never a second source. */
  projectedYieldBbl: number;
}

/**
 * "Ingredient deposit for 25% of #B-063, a 2-turn batch of Epic Hazy IPA.
 *  Estimated yield is 8 bbls, final volume is confirmed at packaging."
 * The yield is the partner's share, to the nearest half barrel, and says
 * "estimated" because shrinkage lands at packaging.
 */
export function depositInvoiceDescription(share: DepositShare): string {
  return `Ingredient deposit for ${formatSharePct(share.sharePct)} of ${batchLabel(share.batchNumber)}, ` +
    `${turnsPhrase(share.turns)} of ${share.beerName.trim()}. ${estimatedYieldSentence(share)}`;
}

/** Whole percent; under one percent reads "<1%" rather than "0%". */
export function formatSharePct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Nearest half barrel, "8 bbls" / "3.5 bbls" / "1 bbl". */
export function formatHalfBbl(bbl: number): string {
  const half = Math.round(bbl * 2) / 2;
  const n = Number.isInteger(half) ? String(half) : half.toFixed(1);
  return `${n} ${half === 1 ? "bbl" : "bbls"}`;
}

/** Actual shipped volume to one decimal, "7 bbl" / "4.7 bbl". */
export function formatShippedBbl(bbl: number): string {
  const n = (Math.round(bbl * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${n} bbl`;
}

function batchLabel(batchNumber: string): string {
  const n = batchNumber.trim();
  return n.startsWith("#") ? n : `#${n}`;
}

function turnsPhrase(turns: number): string {
  return `a ${Math.max(1, Math.round(turns))}-turn batch`;
}

function estimatedYieldSentence(share: DepositShare): string {
  const shareBbl = share.projectedYieldBbl * (share.sharePct / 100);
  return `Estimated yield is ${formatHalfBbl(shareBbl)}, final volume is confirmed at packaging.`;
}

// ── Line items ───────────────────────────────────────────────────────────────

/** The deposit invoice's single line. Bills against the Square "Ingredient Deposit" item. */
export const DEPOSIT_LINE_DESCRIPTION = "Ingredient Deposit";

/**
 * The ingredient-share line on an export invoice:
 * "Ingredient Cost — Ingredients used to produce the 7 bbl of Epic Hazy IPA shipped from #B-063".
 * The shipped volume is actual, not an estimate, so a figure is allowed (one
 * decimal). The "Ingredient Cost" prefix is load-bearing — isIngredientDepositLine
 * matches it. Packaging has its own lines, so this names ingredients only.
 */
export function ingredientCostLineDescription(beerName: string, batchNumber: string | null | undefined, shippedBbl: number): string {
  const from = batchNumber ? ` from ${batchLabel(batchNumber)}` : "";
  return `${INGREDIENT_COST_PREFIX} — Ingredients used to produce the ${formatShippedBbl(shippedBbl)} of ${beerName.trim()} shipped${from}`;
}

/** Packaging Fee lines carry the beer so a multi-recipe invoice is unambiguous. */
export function packagingFeeLineDescription(displayName: string, beerName: string | null | undefined): string {
  return beerName ? `${displayName} — ${beerName}` : displayName;
}

export function packagingMaterialsLineDescription(beerName: string | null | undefined): string {
  return beerName ? `Packaging Materials — ${beerName}` : "Packaging Materials";
}

/** Taxed volume in the unit the rate is charged on: "4.7 bbl" or "751.1 gal". */
export function formatTaxedVolume(bbl: number, basis: "per_bbl" | "per_gallon"): string {
  if (basis === "per_gallon") {
    const gal = (Math.round(bbl * GALLONS_PER_BBL * 10) / 10).toFixed(1).replace(/\.0$/, "");
    return `${gal} gal`;
  }
  return formatShippedBbl(bbl);
}

/**
 * Excise is a statutory pass-through, one line per receiving party (Federal,
 * NC) because each bills against its own Square item. The line names the
 * volume the tax was charged on, to one decimal, in the unit of the rate's
 * basis so the partner can tie amount to rate: "Excise Tax — TTB (7.5 bbl
 * taxed)" for a per-bbl rate, "Excise Tax — NC DOR (232.5 gal taxed)" for a
 * per-gallon one.
 */
export function exciseTaxLineDescription(
  receivingParty: string,
  taxedBbl: number,
  basis: "per_bbl" | "per_gallon" = "per_bbl",
): string {
  return `Excise Tax — ${receivingParty} (${formatTaxedVolume(taxedBbl, basis)} taxed)`;
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

/**
 * Reason text Square shows the customer when a paid deposit is partly refunded:
 * "Partial adjustment of previous deposit for 25% of #B-063, a 2-turn batch of
 *  Epic Hazy IPA. Refund drops allocation from 25% to 10%. Estimated yield is
 *  3.5 bbls, final volume is confirmed at packaging."
 * The yield is the NEW share's.
 */
export function depositReductionRefundReason(share: DepositShare & { newSharePct: number }): string {
  return `Partial adjustment of previous deposit for ${formatSharePct(share.sharePct)} of ${batchLabel(share.batchNumber)}, ` +
    `${turnsPhrase(share.turns)} of ${share.beerName.trim()}. ` +
    `Refund drops allocation from ${formatSharePct(share.sharePct)} to ${formatSharePct(share.newSharePct)}. ` +
    estimatedYieldSentence({ ...share, sharePct: share.newSharePct });
}
