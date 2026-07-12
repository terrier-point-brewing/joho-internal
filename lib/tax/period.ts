// Generic tax period math: month/quarter/year boundaries + due-date helpers.
//
// Pure, dependency-free, no I/O. All dates in/out are YYYY-MM-DD strings.
// TZ-safety: every Date this module receives or constructs is treated by its
// UTC calendar components (getUTCFullYear/getUTCMonth/getUTCDate) or built via
// Date.UTC(...) anchored at noon. Callers should pass `ref` dates anchored at
// a stable instant (e.g. `T12:00:00Z`) so the intended calendar day can never
// shift across a host timezone — the same convention lib/utils/datetime.ts
// uses for addDaysStr/weekdayOf. This module never reads the host clock or
// the brewery timezone; it operates purely on the calendar components given.

import type { Frequency } from "./types";

export interface PeriodBounds {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseIsoParts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

// UTC calendar components of `date`. Callers are responsible for anchoring
// `date` (e.g. at UTC noon) so this never disagrees with the intended day.
function ymdOf(date: Date): { y: number; m: number; d: number } {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

// Number of days in month `m` (1-indexed) of year `y`. Anchored at UTC noon
// on "day 0 of next month" (== last day of this month) so it never touches
// the host's local timezone.
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
}

export function monthPeriod(ref: Date): PeriodBounds {
  const { y, m } = ymdOf(ref);
  return { start: toIso(y, m, 1), end: toIso(y, m, daysInMonth(y, m)) };
}

export function quarterPeriod(ref: Date): PeriodBounds {
  const { y, m } = ymdOf(ref);
  const quarterIndex = Math.floor((m - 1) / 3); // 0..3
  const startMonth = quarterIndex * 3 + 1;
  const endMonth = startMonth + 2;
  return { start: toIso(y, startMonth, 1), end: toIso(y, endMonth, daysInMonth(y, endMonth)) };
}

export function yearPeriod(ref: Date): PeriodBounds {
  const { y } = ymdOf(ref);
  return { start: toIso(y, 1, 1), end: toIso(y, 12, 31) };
}

export function periodContaining(freq: Frequency, ref: Date): PeriodBounds {
  switch (freq) {
    case "monthly":
      return monthPeriod(ref);
    case "quarterly":
      return quarterPeriod(ref);
    case "annual":
      return yearPeriod(ref);
    default: {
      const _exhaustive: never = freq;
      throw new Error(`Unknown tax frequency: ${_exhaustive}`);
    }
  }
}

// Last calendar day of the month following the month containing `end`
// (a YYYY-MM-DD string), e.g. '2026-06-30' -> '2026-07-31'. Used to compute
// filing due dates (NC DOR: due by the end of the month after the period).
export function lastDayOfFollowingMonth(end: string): string {
  const { y, m } = parseIsoParts(end);
  let followingYear = y;
  let followingMonth = m + 1;
  if (followingMonth > 12) {
    followingMonth = 1;
    followingYear += 1;
  }
  return toIso(followingYear, followingMonth, daysInMonth(followingYear, followingMonth));
}

// Add `days` (may be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD.
// Anchored at UTC noon so DST/host-timezone can never drop or duplicate a day.
export function addDaysIso(iso: string, days: number): string {
  const { y, m, d } = parseIsoParts(iso);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + days);
  const { y: ry, m: rm, d: rd } = ymdOf(date);
  return toIso(ry, rm, rd);
}
