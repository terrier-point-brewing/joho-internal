// lib/production/kegDrift.ts
//
// Do Square and cold storage agree about kegs?
//
// The grain is ONE SQUARE VARIATION, not one mapping. Square holds a single count
// per keg SKU, but several cold-storage variations can map into it — Vienna Lager
// keeps a house "1/6 Keg" and a contract-branded "Fortnight - 1/6 Keg", both
// pointing at the same Square SKU. Comparing each mapping separately against the
// same Square number produces two rows that are each wrong; the comparable
// quantity is the sum.
//
// That makes kegs the same shape as cans, where Square derives packs from one
// loose pool — so kegs get the same treatment: a total, plus the components that
// sum to it, because a variance you cannot decompose is not reviewable.
//
// Measurement only — nothing here writes to Square.

import { coldStorageKey, type ColdStorageOnHand } from "./coldStorageOnHand";

export interface KegLink {
  recipeId: string;
  /** packaging_variations.id — the cold-storage side of the mapping. */
  variationId: string;
  squareVariationId: string;
  /** The Square variation's name, e.g. "1/6 Keg". */
  variationName: string | null;
  /** The cold-storage variation's name, e.g. "Fortnight - 1/6 Keg". */
  coldStorageLabel: string | null;
}

export interface KegComponent {
  variationId: string;
  label: string | null;
  onHand: number;
}

export interface KegMeasurement {
  recipeId: string;
  squareVariationId: string;
  variationName: string | null;
  coldStorageKegs: number;
  squareKegs: number;
  /**
   * Units Square is holding COMMITTED against an unpaid invoice we raised.
   *
   * Square keeps committed stock OUT of "available" but still inside IN_STOCK,
   * and only moves it out at payment. So the number Square's IN_STOCK should
   * hold, for available to equal cold storage, is cold storage PLUS this.
   */
  committedKegs: number;
  /** What IN_STOCK should read: coldStorageKegs + committedKegs. */
  targetKegs: number;
  drift: number; // squareKegs - targetKegs
  /** The cold-storage variations that sum to `coldStorageKegs`. */
  components: KegComponent[];
  /**
   * Set when one Square SKU is mapped under more than one recipe. The sum is
   * still the right comparison, but it is a mapping smell worth showing.
   */
  multiRecipe?: string[];
}

export interface KegUnmeasured {
  recipeId: string;
  squareVariationId: string;
  variationName: string | null;
  reason: string;
}

export interface KegDriftResult {
  measurements: KegMeasurement[];
  unmeasured: KegUnmeasured[];
}

/**
 * PURE. `squareCountByVar` holds only the variations Square actually answered
 * for — a missing key means unknown, and an unknown count is not zero. That
 * distinction is the whole reason the can reconciler chased a phantom drift for
 * nine days, so kegs get it from the start rather than inheriting the bug.
 *
 * A cold-storage row that is simply absent DOES mean zero: the app owns that
 * table, so no row there is a positive statement that none are on hand.
 */
export function measureKegDrift(input: {
  links: KegLink[];
  coldStorage: Map<string, ColdStorageOnHand>;
  squareCountByVar: Record<string, number>;
  /** Square variation id → units committed to unpaid invoices. Absent = none. */
  committedByVar?: Record<string, number>;
}): KegDriftResult {
  const measurements: KegMeasurement[] = [];
  const unmeasured: KegUnmeasured[] = [];

  // Group by the Square SKU — the side that holds one number.
  const bySquareVar = new Map<string, KegLink[]>();
  for (const l of input.links) {
    const list = bySquareVar.get(l.squareVariationId) ?? [];
    list.push(l);
    bySquareVar.set(l.squareVariationId, list);
  }

  for (const [squareVariationId, links] of bySquareVar) {
    const first = links[0];
    const squareKegs = input.squareCountByVar[squareVariationId];
    if (squareKegs === undefined) {
      unmeasured.push({
        recipeId: first.recipeId,
        squareVariationId,
        variationName: first.variationName,
        reason: "Square returned no count for this variation — unknown, not zero",
      });
      continue;
    }

    // Dedupe by cold-storage variation: the same variation mapped twice must not
    // have its on-hand counted twice.
    const seen = new Set<string>();
    const components: KegComponent[] = [];
    let coldStorageKegs = 0;
    for (const l of links) {
      if (seen.has(l.variationId)) continue;
      seen.add(l.variationId);
      const onHand = input.coldStorage.get(coldStorageKey(l.recipeId, l.variationId))?.qty ?? 0;
      components.push({ variationId: l.variationId, label: l.coldStorageLabel, onHand });
      coldStorageKegs += onHand;
    }

    const recipeIds = [...new Set(links.map((l) => l.recipeId))];
    // Compensate rather than compare raw. Cold storage was drawn down at SHIP;
    // Square commits the same units when the invoice is raised and only removes
    // them from IN_STOCK at payment. Measuring against cold storage alone would
    // call that overlap "drift" and push IN_STOCK down into the commitment,
    // taking the beer twice.
    const committedKegs = input.committedByVar?.[squareVariationId] ?? 0;
    const targetKegs = coldStorageKegs + committedKegs;
    measurements.push({
      recipeId: first.recipeId,
      squareVariationId,
      variationName: first.variationName,
      coldStorageKegs,
      squareKegs,
      committedKegs,
      targetKegs,
      drift: squareKegs - targetKegs,
      components,
      ...(recipeIds.length > 1 ? { multiRecipe: recipeIds } : {}),
    });
  }

  return { measurements, unmeasured };
}
