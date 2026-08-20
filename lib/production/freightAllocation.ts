import { normalizeUnit, ouncesPerUnit } from "./units";

export interface FreightLineInput {
  unit: string;
  quantity: number;
  /** Optional name, so a guessed line can be reported by something other than its index. */
  label?: string;
  /**
   * Ounces per one of this line, when the caller knows it directly.
   *
   * Ingredients derive weight from their unit string — "lbs" is 16 oz and
   * always will be. Packaging cannot: every packaging item is counted in
   * pieces, and a piece is a can or a keg or a label, which is a fact about
   * the item rather than about its unit. So packaging_items carries its own
   * unit_weight_oz and passes it here.
   *
   * Takes precedence over the unit lookup. Null or undefined falls through.
   */
  ouncesPerPiece?: number | null;
}

export interface FreightAllocation {
  /** Dollars per line, in input order, summing exactly to the freight total. */
  dollars: number[];
  /**
   * Lines whose unit names no known weight, so their share was guessed rather
   * than weighed. Empty on the normal path.
   *
   * This is the whole reason the function returns a shape instead of an array.
   * The fallback is a real guess — a yeast brick counted as though it weighed
   * a pound — and it lands in cost_per_unit_usd, which feeds inventory
   * valuation and every recipe's cost per turn. A guess that reaches the books
   * silently is indistinguishable from a measurement.
   */
  guessed: { label: string; unit: string }[];
}

/**
 * Splits `freightTotalDollars` across `lines` proportional to weight, derived
 * per-line from `unit` (fuzzy-matched against a small known-weight-unit table) x
 * `quantity`. Lines whose unit doesn't match a known weight unit are treated as
 * 1 [their unit] = 1 [the batch's majority matched unit]; if no line matches any
 * known unit, every line falls back to weight = quantity (pure quantity split).
 * Either way those lines come back named in `guessed` — see above.
 *
 * Uses largest-remainder rounding so the returned dollars sum exactly to
 * `freightTotalDollars` (to the cent).
 */
export function allocateFreightByWeight(
  lines: FreightLineInput[],
  freightTotalDollars: number
): FreightAllocation {
  if (lines.length === 0) return { dollars: [], guessed: [] };

  const factors = lines.map((l) => l.ouncesPerPiece ?? ouncesPerUnit(l.unit));

  // Majority matched unit (by count, ties broken by first occurrence).
  const counts = new Map<string, number>();
  const order: string[] = [];
  lines.forEach((l, i) => {
    if (factors[i] == null) return;
    // A line weighed via ouncesPerPiece has no meaningful unit string to
    // contribute — packaging passes "" — so it must not become the majority.
    if (l.ouncesPerPiece != null) return;
    const norm = normalizeUnit(l.unit);
    if (!counts.has(norm)) { counts.set(norm, 0); order.push(norm); }
    counts.set(norm, counts.get(norm)! + 1);
  });
  let majorityFactor = 1;
  if (order.length > 0) {
    let best = order[0];
    for (const u of order) {
      if (counts.get(u)! > counts.get(best)!) best = u;
    }
    majorityFactor = ouncesPerUnit(best)!;
  }

  const guessed = lines
    .map((l, i) => (factors[i] == null ? { label: l.label ?? `line ${i + 1}`, unit: l.unit } : null))
    .filter((g): g is { label: string; unit: string } => g !== null);

  const weights = lines.map((l, i) => l.quantity * (factors[i] ?? majorityFactor));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return { dollars: lines.map(() => 0), guessed };

  const totalCents = Math.round(freightTotalDollars * 100);
  const raw = weights.map((w) => (w / totalWeight) * totalCents);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);

  const byFrac = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const cents = [...floors];
  for (let k = 0; k < byFrac.length && remainder > 0; k++) {
    cents[byFrac[k].idx] += 1;
    remainder--;
  }

  return { dollars: cents.map((c) => c / 100), guessed };
}
