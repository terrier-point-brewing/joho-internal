import type { AlertSeverity } from "../types";

/** Whole days from `iso` (date or timestamp) to `today` (YYYY-MM-DD). */
export function daysOld(iso: string | null | undefined, today: string): number {
  if (!iso) return 0;
  const then = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return 0;
  return Math.floor((now - then) / 86_400_000);
}

/** `info` until the thing has waited `days` days; `danger` from then on. */
export function agedSeverity(iso: string | null | undefined, today: string, days: number): AlertSeverity {
  return daysOld(iso, today) >= days ? "danger" : "info";
}

export function isoDate(iso: string | null | undefined): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export function bbl(n: number | string | null | undefined): string {
  return `${Number(n ?? 0).toFixed(2)} bbl`;
}

export function dollars(cents: number | null | undefined): string {
  return (Number(cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Supabase embeds a to-one relation as an object, or as a one-element array under some clients. */
export function one<T>(rel: T | T[] | null | undefined): T | null {
  if (rel == null) return null;
  return Array.isArray(rel) ? rel[0] ?? null : rel;
}
