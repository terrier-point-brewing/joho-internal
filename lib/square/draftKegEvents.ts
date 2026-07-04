import type { PhysicalCount } from "./inventory";

export interface KegSwapEvent {
  physicalCountId: string;   // the PhysicalCount.id that crossed back up (idempotency anchor)
  date: string;              // occurred_at, YYYY-MM-DD
  occurredAt: string;        // raw occurred_at
  remainingFlOz: number;     // fl oz still in the keg just before the swap (the prior count)
}

// 580/660 preserves the existing draft-stats threshold behavior for 1/6 kegs.
export const SWAP_THRESHOLD_FRACTION = 580 / 660;

/**
 * Detect keg swaps from a series of physical counts for a single draft variation.
 * A swap is a count that crosses back up over the "nearly full" threshold: the
 * quantity drops as the keg is poured, then jumps back up when a fresh keg is tapped.
 * `remainingFlOz` is the last count before the crossing — the beer left in the keg
 * when it was swapped out (i.e. the shrinkage/waste).
 */
export function detectKegSwaps(counts: PhysicalCount[], fullVolumeFlOz: number): KegSwapEvent[] {
  const sorted = [...counts].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const threshold = fullVolumeFlOz * SWAP_THRESHOLD_FRACTION;
  const events: KegSwapEvent[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseFloat(sorted[i - 1].quantity);
    const curr = parseFloat(sorted[i].quantity);
    if (curr >= threshold && prev < threshold) {
      events.push({
        physicalCountId: sorted[i].id,
        date:            sorted[i].occurred_at.slice(0, 10),
        occurredAt:      sorted[i].occurred_at,
        remainingFlOz:   Number(prev.toFixed(1)),
      });
    }
  }
  return events;
}
