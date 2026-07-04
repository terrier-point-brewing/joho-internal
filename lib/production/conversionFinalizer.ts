/** Batch status implied by the stage a batch occupies in a given equipment type. */
export function conversionTargetStatus(
  destType: string | null | undefined,
): "fermenting" | "conditioning" | null {
  switch (destType) {
    case "fermenter": return "fermenting";
    case "brite":     return "conditioning";
    default:          return null;
  }
}

/** Ordered lifecycle rank; higher = later. Unknown/null ranks lowest. */
export const STATUS_RANK: Record<string, number> = {
  planning: 0, brewing: 1, fermenting: 2, conditioning: 3, complete: 4,
};

/** True when `to` is a strictly later stage than `from` (forward-only guard). */
export function isForward(from: string | null | undefined, to: string): boolean {
  const fromRank = from != null && from in STATUS_RANK ? STATUS_RANK[from] : -1;
  const toRank = to in STATUS_RANK ? STATUS_RANK[to] : -1;
  return toRank > fromRank;
}
