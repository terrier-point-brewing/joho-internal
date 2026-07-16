/** Ounces per 1 unit, keyed by normalized unit string. */
const OZ_PER_UNIT: Record<string, number> = {
  oz: 1, ounce: 1, ounces: 1,
  lb: 16, lbs: 16, pound: 16, pounds: 16, "#": 16,
  g: 0.035274, gram: 0.035274, grams: 0.035274,
  kg: 35.274, kilogram: 35.274, kilograms: 35.274,
};

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.$/, "");
}

function ozPerUnit(unit: string): number | null {
  return OZ_PER_UNIT[normalizeUnit(unit)] ?? null;
}

export interface FreightLineInput {
  unit: string;
  quantity: number;
}

/**
 * Splits `freightTotalDollars` across `lines` proportional to weight, derived
 * per-line from `unit` (fuzzy-matched against a small known-weight-unit table) x
 * `quantity`. Lines whose unit doesn't match a known weight unit are treated as
 * 1 [their unit] = 1 [the batch's majority matched unit]; if no line matches any
 * known unit, every line falls back to weight = quantity (pure quantity split).
 * Uses largest-remainder rounding so the returned dollars sum exactly to
 * `freightTotalDollars` (to the cent).
 */
export function allocateFreightByWeight(
  lines: FreightLineInput[],
  freightTotalDollars: number
): number[] {
  if (lines.length === 0) return [];

  const factors = lines.map((l) => ozPerUnit(l.unit));

  // Majority matched unit (by count, ties broken by first occurrence).
  const counts = new Map<string, number>();
  const order: string[] = [];
  lines.forEach((l, i) => {
    if (factors[i] == null) return;
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
    majorityFactor = OZ_PER_UNIT[best];
  }

  const weights = lines.map((l, i) => l.quantity * (factors[i] ?? majorityFactor));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return lines.map(() => 0);

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

  return cents.map((c) => c / 100);
}
