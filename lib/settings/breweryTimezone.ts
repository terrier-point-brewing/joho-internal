// Brewery timezone — the single physical-location zone that all sales reporting,
// targets, and day-bucketed metrics are calculated in. Stored in the generic
// `system_settings` key/value table (key = "brewery_timezone") so an admin can
// change it in the UI without a deploy. `BREWERY_TZ` in lib/utils/datetime.ts is
// the compile-time fallback used until (or unless) a value is set.
//
// This module is isomorphic (safe in both client and server bundles): it holds
// only the option list, labels, and keys. The server-only accessor that reads
// the stored value lives in `breweryTimezone.server.ts` so its Supabase/cache
// imports never leak into the client bundle. Server code resolves the active
// zone via `getBreweryTimezone()`; client code uses the `useBreweryTimezone` hook.

import { BREWERY_TZ } from "@/lib/utils/datetime";

/** Fallback zone when no setting is stored (matches the historical hard-coded value). */
export const DEFAULT_BREWERY_TZ = BREWERY_TZ;

/** `system_settings` row key. */
export const BREWERY_TIMEZONE_KEY = "brewery_timezone";

/** Cache tag — revalidated when the setting changes so readers refresh. */
export const BREWERY_TIMEZONE_TAG = "brewery-timezone";

export interface TimezoneOption {
  value: string; // IANA identifier
  label: string; // human-friendly name shown in the picker
}

// US zones the taproom could plausibly live in. Kept intentionally small and
// labeled; extend here if the business ever operates outside these.
export const SUPPORTED_TIMEZONES: readonly TimezoneOption[] = [
  { value: "America/New_York",    label: "US Eastern — New York" },
  { value: "America/Chicago",     label: "US Central — Chicago" },
  { value: "America/Denver",      label: "US Mountain — Denver" },
  { value: "America/Phoenix",     label: "US Mountain (no DST) — Phoenix" },
  { value: "America/Los_Angeles", label: "US Pacific — Los Angeles" },
  { value: "America/Anchorage",   label: "US Alaska — Anchorage" },
  { value: "Pacific/Honolulu",    label: "US Hawaii — Honolulu" },
] as const;

/** True if `tz` is one of the offered zones. */
export function isSupportedTimezone(tz: unknown): tz is string {
  return typeof tz === "string" && SUPPORTED_TIMEZONES.some((t) => t.value === tz);
}

/** Human-friendly label for a zone (falls back to the raw IANA id). */
export function timezoneLabel(tz: string): string {
  return SUPPORTED_TIMEZONES.find((t) => t.value === tz)?.label ?? tz;
}
