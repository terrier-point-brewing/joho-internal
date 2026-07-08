/**
 * The money-unit boundary. This module is the single, explicit crossing point
 * between the two money representations used in this codebase:
 *
 *   - **Cents**   — integer minor units (Square's native money format, and how
 *                   `*_cents` columns are stored). Always whole numbers.
 *   - **Dollars** — a decimal USD amount (how `*_usd` / per-unit cost columns
 *                   are stored, where sub-cent precision is legitimate).
 *
 * The two are branded so a value in one unit can't be silently passed where the
 * other is expected — a `Cents` won't type-check as a `Dollars` and vice versa.
 * Branding is a compile-time-only device: at runtime these are plain `number`s.
 *
 * Dependency-free by design — safe to import anywhere (client or server).
 */

/** Integer minor units (e.g. `1599` = $15.99). Branded to prevent unit mixups. */
export type Cents = number & { readonly __brand: "Cents" };

/** Decimal USD (e.g. `15.99`). Branded to prevent unit mixups. */
export type Dollars = number & { readonly __brand: "Dollars" };

/**
 * Convert a dollars amount to integer cents, rounding to the nearest cent.
 * `dollarsToCents(0.6171)` → `62`. This is THE dollars→cents crossing; prefer
 * it over an inline `Math.round(x * 100)` so the unit change is named.
 */
export function dollarsToCents(d: number): Cents {
  return Math.round(d * 100) as Cents;
}

/**
 * Convert integer cents to a dollars amount. `centsToDollars(1599)` → `15.99`.
 * This is THE cents→dollars crossing; prefer it over an inline `c / 100`.
 */
export function centsToDollars(c: number): Dollars {
  return (c / 100) as Dollars;
}

/**
 * Brand an existing number as `Cents` without conversion. Use at a boundary
 * where a plain `number` is already known to be integer cents (e.g. a value
 * read from a `*_cents` column or Square's `amount_money.amount`).
 */
export function cents(n: number): Cents {
  return n as Cents;
}

/**
 * Brand an existing number as `Dollars` without conversion. Use at a boundary
 * where a plain `number` is already known to be a decimal USD amount (e.g. a
 * value read from a `*_usd` or per-unit cost column).
 */
export function dollars(n: number): Dollars {
  return n as Dollars;
}
