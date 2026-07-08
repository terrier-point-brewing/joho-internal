// lib/production/coldStorageBreak.ts
//
// Pure planner for cold-storage pack break-downs. Given the can-identity family's
// tiers (single < pack < case) with current on-hand and cans-per-tier, decide the
// minimal sequence of ONE-LEVEL breaks needed to raise the target tier's on-hand
// to `needed`. Greedy + smallest-first: always crack the LOWEST higher tier that
// has stock, so sealed cases survive for wholesale, and a case only breaks into
// packs (never straight to singles). No IO — callers supply the loaded state.

export interface Tier {
  variationId: string;
  format: string;   // 'loose' | '4-pack' | '6-pack' | 'case'
  cansEach: number; // cans in one unit of this tier (single=1, pack=4|6, case=24)
  onHand: number;   // current cold-storage units of this tier
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
  const sorted = [...input.tiers].sort((a, b) => a.cansEach - b.cansEach);

  const onHand: Record<string, number> = {};
  for (const t of sorted) onHand[t.variationId] = t.onHand;

  const targetIndex = sorted.findIndex((t) => t.variationId === targetVariationId);
  if (targetIndex === -1) throw new Error(`planBreakDown: target variation ${targetVariationId} not in tiers`);

  const ops: BreakOp[] = [];
  let guard = 0;
  while (onHand[targetVariationId] < needed - EPS) {
    if (++guard > MAX_ITERS) throw new Error("planBreakDown: did not converge");

    // Lowest tier strictly above the target that has at least one unit on hand.
    let src = -1;
    for (let i = targetIndex + 1; i < sorted.length; i++) {
      if (onHand[sorted[i].variationId] >= 1 - EPS) { src = i; break; }
    }
    if (src === -1) break; // nothing left to crack -> shortfall

    const parent = sorted[src];
    const child = sorted[src - 1]; // exactly one level down
    const toUnits = parent.cansEach / child.cansEach;
    onHand[parent.variationId] -= 1;
    onHand[child.variationId] += toUnits;
    ops.push({ fromVariationId: parent.variationId, toVariationId: child.variationId, fromUnits: 1, toUnits });
  }

  const shortfall = Math.max(0, needed - onHand[targetVariationId]);
  return { ops, resultingOnHand: onHand, shortfall };
}
