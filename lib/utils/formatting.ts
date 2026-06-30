import { formatCurrency, formatCurrencyCents, formatNumber, EM_DASH } from "@/lib/format";

export function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

// Bare cents-to-dollar string (no "$") used for API response payloads, not
// display. Left as-is intentionally — see lib/format.ts for display helpers.
export function cents(n: number): string {
  return (n / 100).toFixed(2);
}

// Anchor date-only strings to local noon so UTC-behind timezones don't roll
// them back a day.  Full ISO timestamps (containing "T") are left unchanged.
function anchored(iso: string): Date {
  return new Date(iso.includes("T") ? iso : iso.slice(0, 10) + "T12:00:00");
}

export function fmtDate(iso: string): string {
  return anchored(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateLong(iso: string): string {
  return anchored(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export function fmtBbl(v: number): string {
  return v.toFixed(3) + " BBL";
}

export function fmtBbl2(v: number): string {
  return v.toFixed(2) + " BBL";
}

// Money display helpers — thin aliases over the single source of truth in
// lib/format.ts. Kept for the many existing call sites; prefer importing the
// format.ts functions directly in new code.
export function fmtUsd(n: number): string {
  return formatCurrency(n);
}

export function fmtCents(n: number): string {
  return formatCurrencyCents(n);
}

export function fmtUsd0(n: number): string {
  return Number.isFinite(n) ? `$${formatNumber(n, 0)}` : EM_DASH;
}
