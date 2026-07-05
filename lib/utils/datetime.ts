// Timezone-aware date helpers.
//
// The brewery (single location: Holly Springs Taproom) operates on US Eastern
// time, but report routes run on Vercel in UTC. Parsing "2026-06-03T00:00:00"
// with `new Date(...)` interprets it in the *runtime's* zone, so day boundaries
// and daily buckets silently shift by the UTC offset. Everything here pins the
// conversion to the brewery zone so a requested calendar day means that day in
// the taproom, regardless of where the code runs.

export const BREWERY_TZ = "America/New_York";

// Offset (ms) of `tz` from UTC at the instant `date`. Positive when the zone is
// ahead of UTC. Computed via Intl so DST is handled automatically.
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value);
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour % 24, map.minute, map.second);
  return asUTC - date.getTime();
}

// Convert a wall-clock time in `tz` (given as Y/M/D H:M:S.ms) to the matching
// UTC instant. Two passes converge across DST boundaries.
function wallClockToUtc(
  y: number, mo: number, d: number,
  h: number, mi: number, s: number, ms: number,
  tz: string,
): Date {
  let utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMs(new Date(utc), tz);
    utc = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset;
  }
  return new Date(utc);
}

// Start of the given calendar day (00:00:00.000 brewery-local) as a UTC ISO string.
export function dayStartUtc(dateStr: string, tz: string = BREWERY_TZ): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return wallClockToUtc(y, mo, d, 0, 0, 0, 0, tz).toISOString();
}

// End of the given calendar day (23:59:59.999 brewery-local) as a UTC ISO string.
export function dayEndUtc(dateStr: string, tz: string = BREWERY_TZ): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return wallClockToUtc(y, mo, d, 23, 59, 59, 999, tz).toISOString();
}

// UTC instant range covering [startDate 00:00 .. endDate 23:59:59.999] local.
export function dayRangeUtc(
  startDate: string,
  endDate: string,
  tz: string = BREWERY_TZ,
): { startUtc: string; endUtc: string } {
  return { startUtc: dayStartUtc(startDate, tz), endUtc: dayEndUtc(endDate, tz) };
}

// The brewery-local calendar date (YYYY-MM-DD) for a UTC timestamp. Use this to
// bucket orders/refunds by business day instead of slicing the raw UTC ISO.
export function localDateString(iso: string, tz: string = BREWERY_TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// Inclusive list of calendar date strings from startDate to endDate.
export function eachDateString(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  // Anchor at UTC noon so adding days never trips over a DST boundary.
  const cur = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Add `n` days (may be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD.
// Anchored at UTC noon so DST transitions never drop or duplicate a day. This is
// pure calendar arithmetic — it never touches the runtime's local zone, so the
// result is identical no matter where the code runs (browser or server).
export function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Day of week (0=Sun .. 6=Sat) for a YYYY-MM-DD calendar date, evaluated at UTC
// noon so the runtime's local zone can never shift it to an adjacent day.
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

// The current calendar date (YYYY-MM-DD) in the given zone. Pass an explicit
// `now` for deterministic tests; defaults to the real current instant. Use this
// instead of `new Date().getFullYear()` etc. so "today" means today *at the
// brewery*, not in whatever zone the viewer's browser happens to be in.
export function todayLocalDate(tz: string = BREWERY_TZ, now: Date = new Date()): string {
  return localDateString(now.toISOString(), tz);
}
