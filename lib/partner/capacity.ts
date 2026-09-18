/**
 * Open brewing capacity, as a partner may see it.
 *
 * Derived from the schedule and nothing else — no capacity figure is typed in
 * anywhere. The fermenter is the binding constraint: a brew needs one empty
 * fermenter, big enough, for the recipe's whole fermentation. Brewhouse and
 * brite time are deliberately ignored; adding them muddles a number whose only
 * job is to say "is there room, and roughly when".
 *
 * Everything here is pure and works in whole UTC days, so it is testable
 * without a clock and never leaks which tank or which batch is in the way.
 */

export const TURN_BBL = 20;
export const HORIZON_MONTHS = 6;
const DAY_MS = 86_400_000;

export interface Fermenter { id: string; capacity_bbl: number | null }
/** A stretch a fermenter is spoken for. Dates are ISO strings; end is exclusive. */
export interface BusyInterval { equipment_id: string; start: string; end: string }

export interface MonthCapacity {
  /** "2026-10" */
  month: string;
  open_slots: number;
  /** First day a brew could start this month, or null when the month is full. */
  earliest_start: string | null;
  /** Largest brew, in turns, that any open slot this month could hold. */
  max_turns: number;
}

export interface BrewWindow {
  /** Monday of the week the brew could start. */
  week_of: string;
  /** Roughly when the beer would be ready: start + the recipe's lead time. */
  ready_around: string;
}

const toDay = (iso: string) => Math.floor(Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso) / DAY_MS);
const fromDay = (d: number) => new Date(d * DAY_MS).toISOString().slice(0, 10);
const monthOf = (d: number) => fromDay(d).slice(0, 7);

/** Free [start, end) day ranges for one fermenter inside [from, to). */
export function freeRanges(busy: Array<{ start: number; end: number }>, from: number, to: number): Array<{ start: number; end: number }> {
  const sorted = busy
    .map((b) => ({ start: Math.max(b.start, from), end: Math.min(b.end, to) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = from;
  for (const b of sorted) {
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < to) out.push({ start: cursor, end: to });
  return out;
}

function horizon(today: string): { from: number; to: number } {
  const from = toDay(today) + 1; // nothing starts today
  const t = new Date(`${today}T00:00:00Z`);
  const end = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + HORIZON_MONTHS, 1);
  return { from, to: Math.floor(end / DAY_MS) };
}

function busyByFermenter(busy: BusyInterval[]): Map<string, Array<{ start: number; end: number }>> {
  const m = new Map<string, Array<{ start: number; end: number }>>();
  for (const b of busy) {
    const list = m.get(b.equipment_id) ?? [];
    // A half-day booking still occupies the tank that day: round outward.
    list.push({ start: toDay(b.start), end: Math.ceil(Date.parse(b.end.length <= 10 ? `${b.end}T00:00:00Z` : b.end) / DAY_MS) });
    m.set(b.equipment_id, list);
  }
  return m;
}

/**
 * The six-month strip. A month's `open_slots` is the number of fermenters that
 * could take a brew STARTING that month — free for the whole of `fermentDays`
 * from some day in it. Each month is judged on its own, so it answers "if I
 * wanted October, is there room?"; it is not a running total, and one free tank
 * counts in every month it is free. Use a conservative (long) `fermentDays`
 * here — the request form recomputes against the actual recipe.
 */
export function monthlyCapacity(input: {
  today: string;
  fermenters: Fermenter[];
  busy: BusyInterval[];
  fermentDays: number;
}): MonthCapacity[] {
  const { from, to } = horizon(input.today);
  const days = Math.max(1, Math.round(input.fermentDays));
  const busy = busyByFermenter(input.busy);

  const months: Array<MonthCapacity & { start: number; end: number }> = [];
  for (let d = from; d < to; ) {
    const m = monthOf(d);
    const first = new Date(`${m}-01T00:00:00Z`);
    const end = Math.floor(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1) / DAY_MS);
    months.push({ month: m, open_slots: 0, earliest_start: null, max_turns: 0, start: d, end });
    d = end;
  }

  for (const f of input.fermenters) {
    const turns = Math.floor(Number(f.capacity_bbl ?? 0) / TURN_BBL);
    if (turns < 1) continue;
    // A brew that starts late in the last month finishes past the horizon;
    // that is still an open slot, so look one fermentation beyond it.
    const gaps = freeRanges(busy.get(f.id) ?? [], from, to + days);
    for (const row of months) {
      let first: number | null = null;
      for (const g of gaps) {
        const start = Math.max(g.start, row.start);
        if (start < row.end && start + days <= g.end) { first = start; break; }
      }
      if (first == null) continue;
      row.open_slots += 1;
      const iso = fromDay(first);
      if (row.earliest_start == null || iso < row.earliest_start) row.earliest_start = iso;
      row.max_turns = Math.max(row.max_turns, turns);
    }
  }
  return months.map((r) => ({ month: r.month, open_slots: r.open_slots, earliest_start: r.earliest_start, max_turns: r.max_turns }));
}

/**
 * Weeks in which THIS beer, at THIS size, could start: some fermenter of at
 * least `turns × 20 bbl` is free from that Monday for the whole fermentation.
 */
export function brewWindows(input: {
  today: string;
  fermenters: Fermenter[];
  busy: BusyInterval[];
  fermentDays: number;
  leadTimeDays: number;
  turns: number;
  limit?: number;
}): BrewWindow[] {
  const { from, to } = horizon(input.today);
  const days = Math.max(1, Math.round(input.fermentDays));
  const busy = busyByFermenter(input.busy);
  const gaps = input.fermenters
    .filter((f) => Number(f.capacity_bbl ?? 0) + 1e-6 >= input.turns * TURN_BBL)
    .flatMap((f) => freeRanges(busy.get(f.id) ?? [], from, to + days));

  const out: BrewWindow[] = [];
  // 1970-01-01 was a Thursday, so day 4 was the first Monday.
  let monday = from + ((4 - (from % 7)) + 7) % 7;
  for (; monday < to && out.length < (input.limit ?? 12); monday += 7) {
    if (gaps.some((g) => g.start <= monday && monday + days <= g.end)) {
      out.push({ week_of: fromDay(monday), ready_around: fromDay(monday + Math.max(days, Math.round(input.leadTimeDays))) });
    }
  }
  return out;
}

/** Largest brew any fermenter could ever hold, in turns. */
export function maxTurns(fermenters: Fermenter[]): number {
  return fermenters.reduce((m, f) => Math.max(m, Math.floor(Number(f.capacity_bbl ?? 0) / TURN_BBL)), 0);
}
