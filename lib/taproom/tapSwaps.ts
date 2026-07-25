/**
 * Queued tap swaps: pairing a frozen beer-change note to the ring that books it.
 *
 * A Draft Restock ring is a point-in-time fact, but `tap_assignments` is mutable
 * current state, so a beer-changing swap could not express its outgoing side. A
 * `tap_swap_transitions` row snapshots both sides when the swap is queued; this
 * module decides which ring consumes which note.
 *
 * Pure — no IO, no clock. `staleSwaps` takes `nowIso` explicitly so the caller
 * owns the clock and tests need no stubbing.
 */

/** One pending `tap_swap_transitions` row, camelCased for use in the sync path. */
export interface PendingTapSwap {
  id: string;
  tapNumber: number;
  /** Outgoing side — all null when the swap fills a previously empty tap. */
  fromRecipeId: string | null;
  fromBeerName: string | null;
  fromVariationId: string | null;
  fromVolumeFlOz: number | null;
  fromDraftSquareVariationId: string | null;
  toRecipeId: string;
  toBeerName: string;
  toVariationId: string;
  toVolumeFlOz: number;
  toDraftSquareVariationId: string | null;
  openedAt: string;
}

/** Minimal shape of a Draft Restock line event needed for pairing. */
interface PairableEvent {
  orderId: string;
  lineUid: string;
  squareVariationId: string;
  occurredAt: string;
}

/** Stable key for a restock line event — matches the `sqtransfer:` source_ref grain. */
export function restockEventKey(orderId: string, lineUid: string): string {
  return `${orderId}:${lineUid}`;
}

/** Group into a Map keyed by tap number. */
function groupByTap<T>(items: T[], tapOf: (item: T) => number | undefined): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const item of items) {
    const tap = tapOf(item);
    if (tap === undefined) continue; // restock variation not mapped to any tap
    const list = out.get(tap) ?? [];
    list.push(item);
    out.set(tap, list);
  }
  return out;
}

/**
 * Pair queued swaps to restock events per tap, FIFO.
 *
 * Returns `restockEventKey(...)` → the swap that event consumes. Events and swaps
 * are each sorted by timestamp with a secondary key (`lineUid` / `id`) — without
 * that tiebreak, two swaps queued in the same second could pair differently on
 * successive runs and book twice.
 *
 * Extra events on a tap (more rings than queued swaps) go unpaired and fall back
 * to like-for-like resolution off `tap_assignments`; extra swaps stay pending.
 */
export function pairSwapsToRestocks(
  events: PairableEvent[],
  tapByRestockVariation: Map<string, number>,
  pending: PendingTapSwap[],
): Map<string, PendingTapSwap> {
  const paired = new Map<string, PendingTapSwap>();

  const eventsByTap = groupByTap(events, (e) => tapByRestockVariation.get(e.squareVariationId));
  const swapsByTap = groupByTap(pending, (s) => s.tapNumber);

  for (const [tap, tapEvents] of eventsByTap) {
    const tapSwaps = swapsByTap.get(tap);
    if (!tapSwaps?.length) continue;

    const sortedEvents = [...tapEvents].sort(
      (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.lineUid.localeCompare(b.lineUid),
    );
    const sortedSwaps = [...tapSwaps].sort(
      (a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id),
    );

    const pairs = Math.min(sortedEvents.length, sortedSwaps.length);
    for (let i = 0; i < pairs; i++) {
      const e = sortedEvents[i];
      paired.set(restockEventKey(e.orderId, e.lineUid), sortedSwaps[i]);
    }
  }

  return paired;
}

/**
 * Queued swaps older than `maxAgeDays` that no event in this window consumed —
 * surfaced as a discrepancy so a swap recorded but never rung becomes visible
 * instead of silently attaching to a much later ring. Never auto-expired.
 */
export function staleSwaps(
  pending: PendingTapSwap[],
  paired: Map<string, PendingTapSwap>,
  nowIso: string,
  maxAgeDays: number,
): PendingTapSwap[] {
  const consumed = new Set([...paired.values()].map((s) => s.id));
  const cutoff = new Date(nowIso).getTime() - maxAgeDays * 86400000;
  return pending.filter(
    (s) => !consumed.has(s.id) && new Date(s.openedAt).getTime() < cutoff,
  );
}
