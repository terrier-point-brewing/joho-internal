/**
 * Single source of truth for number, currency, and percentage formatting.
 *
 * Uses the built-in `Intl.NumberFormat` only (no dependencies). Formatter
 * instances are memoized in a module-level `Map` keyed by format variant so we
 * never construct a formatter per call. Locale and currency are hardcoded to
 * `en-US` / `USD`.
 *
 * Every function returns the shared `EM_DASH` sentinel for `null` / `undefined`
 * / `NaN` inputs so callers don't have to guard each display site themselves.
 */

/** Shared sentinel rendered when a value is missing or not a number. */
export const EM_DASH = "—";

const LOCALE = "en-US";
const CURRENCY = "USD";

/** A nullable numeric input — the union every formatter accepts. */
type Numeric = number | null | undefined;

/**
 * Memoized `Intl.NumberFormat` instances keyed by a string variant. The key
 * encodes every option that distinguishes one formatter from another (style +
 * fraction digits) so distinct configurations never collide.
 */
const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** True when a value is a real, finite number safe to format. */
function isFiniteNumber(value: Numeric): value is number {
  return value != null && typeof value === "number" && !Number.isNaN(value) && Number.isFinite(value);
}

/**
 * Format a money value expressed in **integer cents** (Square's native money
 * format — the unit of every `*_cents` column). Divides by 100 internally, so
 * pass `1599` to render `$15.99`. Do NOT pass dollars here — `15.99` would
 * render `$0.16`. For a value already in dollars use {@link formatCurrency}.
 * `decimals` defaults to 2; pass `0` for whole-dollar displays (`$16`).
 */
export function formatCurrencyCents(cents: Numeric, decimals = 2): string {
  if (!isFiniteNumber(cents)) return EM_DASH;
  return formatCurrency(cents / 100, decimals);
}

/**
 * Format a money value already expressed in **dollars** (the unit of `*_usd`
 * and per-unit cost columns). Pass `15.99` to render `$15.99`. Do NOT pass
 * cents here — `1599` would render `$1,599.00`. For a value in integer cents
 * use {@link formatCurrencyCents}.
 * `decimals` defaults to 2; pass `0` for whole-dollar displays (`$16`).
 */
export function formatCurrency(dollars: Numeric, decimals = 2): string {
  if (!isFiniteNumber(dollars)) return EM_DASH;
  return getFormatter(`currency:${decimals}`, {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(dollars);
}

/**
 * Format a plain number with grouping separators and a fixed number of decimal
 * places (default 0). Pass `1234.5` to render `1,235`, or `(1234.5, 1)` for
 * `1,234.5`.
 */
export function formatNumber(value: Numeric, decimals = 0): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return getFormatter(`number:${decimals}`, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format a ratio as a percentage. `Intl` multiplies by 100, so pass `0.15` to
 * render `15.0%`. `decimals` controls fraction digits (default 1).
 */
export function formatPercent(value: Numeric, decimals = 1): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  return getFormatter(`percent:${decimals}`, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}
