// lib/production/coldStorageBreak.ts
//
// Pure planner for cold-storage pack break-downs. Given the can-identity family's
// tiers (single < pack < case) with current on-hand and an EXPLICIT one-level-down
// edge per tier (childVariationId — what it cracks into), decide the minimal
// sequence of ONE-LEVEL breaks needed to raise the target tier's on-hand to
// `needed`. Greedy + smallest-first: always crack the smallest ANCESTOR of the
// target that has stock, so sealed cases survive for wholesale, and a tier only
// ever cracks into its own declared child (never guessed from volume/format
// adjacency — a family can have both a 4-pack and a 6-pack sibling, and only one
// of them is what a given case was actually built from). No IO — callers supply
// the loaded state including each tier's childVariationId.

export interface Tier {
  variationId: string;
  format: string;   // 'loose' | '4-pack' | '6-pack' | 'case'
  cansEach: number; // cans in one unit of this tier (single=1, pack=4|6, case=24)
  onHand: number;   // current cold-storage units of this tier
  childVariationId: string | null; // tier this one cracks into, one level down; null = base tier (nothing to crack into)
}

export interface BreakOp {
  fromVariationId: string; // the tier cracked (parent)
  toVariationId: string;   // the tier produced, one level down (child)
  fromUnits: number;       // always 1 (one parent per op)
  toUnits: number;         // children produced = cansEach[parent] / cansEach[child]
}

export interface BreakPlan {
  ops: BreakOp[];
  resultingOnHand: Record<string, number>; // variationId -> units after breaks
  shortfall: number;                        // target units still uncovered
}

const EPS = 1e-9;
const MAX_ITERS = 100_000;

export function planBreakDown(input: { tiers: Tier[]; targetVariationId: string; needed: number }): BreakPlan {
  const { targetVariationId, needed } = input;
  const byId = new Map(input.tiers.map((t) => [t.variationId, t]));
  if (!byId.has(targetVariationId)) throw new Error(`planBreakDown: target variation ${targetVariationId} not in tiers`);

  const onHand: Record<string, number> = {};
  for (const t of input.tiers) onHand[t.variationId] = t.onHand;

  // childId -> [parentIds whose declared child is childId]
  const parentsOf = new Map<string, string[]>();
  for (const t of input.tiers) {
    if (!t.childVariationId) continue;
    const list = parentsOf.get(t.childVariationId) ?? [];
    list.push(t.variationId);
    parentsOf.set(t.childVariationId, list);
  }

  // Every tier that transitively cracks down into the target, via declared
  // child edges only (not positional/volume adjacency).
  function ancestorsOf(id: string, seen: Set<string>): string[] {
    const direct = parentsOf.get(id) ?? [];
    const all: string[] = [];
    for (const p of direct) {
      if (seen.has(p)) continue; // guard a malformed cyclic edge, defensively
      seen.add(p);
      all.push(p, ...ancestorsOf(p, seen));
    }
    return all;
  }
  const ancestorIds = new Set(ancestorsOf(targetVariationId, new Set()));

  const ops: BreakOp[] = [];
  let guard = 0;
  while (onHand[targetVariationId] < needed - EPS) {
    if (++guard > MAX_ITERS) throw new Error("planBreakDown: did not converge");

    // Smallest (by cansEach) ancestor of the target that has stock — crack the
    // nearest sealed unit first so bigger units survive as long as possible.
    const parent = [...ancestorIds]
      .map((id) => byId.get(id)!)
      .filter((t) => onHand[t.variationId] >= 1 - EPS)
      .sort((a, b) => a.cansEach - b.cansEach)[0];
    if (!parent) break; // nothing left to crack -> shortfall

    const child = byId.get(parent.childVariationId!)!;
    const toUnits = parent.cansEach / child.cansEach;
    onHand[parent.variationId] -= 1;
    onHand[child.variationId] += toUnits;
    ops.push({ fromVariationId: parent.variationId, toVariationId: child.variationId, fromUnits: 1, toUnits });
  }

  const shortfall = Math.max(0, needed - onHand[targetVariationId]);
  return { ops, resultingOnHand: onHand, shortfall };
}

// ── Tier-size derivation (units validation) ──────────────────────────────────

export interface FamilyVariation {
  variationId: string;
  format: string;           // 'loose' | '4-pack' | '6-pack' | 'case'
  totalVolumeFlOz: number;
}

export interface DerivedTier {
  variationId: string;
  format: string;
  cansEach: number;
}

// Whole cans a format is DEFINED to hold, for cross-checking against volume.
// 'case' sizes vary, so it has no fixed expectation — volume is trusted.
const FORMAT_EXPECTED_CANS: Record<string, number> = { loose: 1, "4-pack": 4, "6-pack": 6 };

/**
 * Derive cans-per-tier from authoritative volumes (each tier's total_volume_fl_oz
 * divided by the loose base can's volume). Emits warnings when a derived count is
 * non-integer or disagrees with the count its `format` implies — surfacing packaging
 * data bugs (e.g. a '6-pack' whose volume is really 4 cans) without trusting the
 * shared paktech/tray can_count.
 */
export function deriveCansEach(input: { variations: FamilyVariation[] }): { tiers: DerivedTier[]; warnings: string[] } {
  const base = input.variations.find((v) => v.format === "loose");
  if (!base) throw new Error("deriveCansEach: family has no loose base-can variation to normalize against");
  const baseVol = base.totalVolumeFlOz;
  if (!(baseVol > 0)) throw new Error("deriveCansEach: loose base-can volume must be positive");

  const warnings: string[] = [];
  const tiers: DerivedTier[] = input.variations.map((v) => {
    const raw = v.totalVolumeFlOz / baseVol;
    const cansEach = Math.round(raw);
    if (Math.abs(raw - cansEach) > 1e-6) {
      warnings.push(`${v.format} variation ${v.variationId}: volume-derived can count ${raw.toFixed(3)} is not a whole number`);
    }
    const expected = FORMAT_EXPECTED_CANS[v.format];
    if (expected !== undefined && cansEach !== expected) {
      warnings.push(`${v.format} variation ${v.variationId}: volume implies ${cansEach} cans, expected ${expected} for format '${v.format}'`);
    }
    return { variationId: v.variationId, format: v.format, cansEach };
  });

  return { tiers, warnings };
}
