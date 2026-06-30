import { formatCurrency, formatCurrencyCents } from "@/lib/format";

type CurrencyProps = {
  /** Money value in dollars (e.g. 15.99). Ignored when `cents` is provided. */
  value?: number | null;
  /** Money value in integer cents (Square's native format, e.g. 1599). */
  cents?: number | null;
  className?: string;
};

/**
 * Renders a currency value with tabular figures so digits align in table
 * columns. Pass `cents` for Square's integer-cent values, otherwise `value`
 * for dollars.
 */
export function Currency({ value, cents, className }: CurrencyProps) {
  const text = cents != null ? formatCurrencyCents(cents) : formatCurrency(value);
  return <span className={`tabular-nums${className ? ` ${className}` : ""}`}>{text}</span>;
}
