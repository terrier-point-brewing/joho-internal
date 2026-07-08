import { formatCurrency, formatCurrencyCents } from "@/lib/format";

/**
 * Exactly one money unit must be supplied. The two props are named for their
 * unit so a call site can never be ambiguous about what it's passing:
 *
 *   - `cents`   — integer cents (Square's native format / `*_cents` columns).
 *                 PREFERRED for anything sourced from a `*_cents` column.
 *   - `dollars` — a decimal USD amount (`*_usd` / per-unit cost columns).
 *
 * When both are given, `cents` wins (it's the safer integer path).
 */
type CurrencyProps =
  | { cents: number | null; dollars?: never; className?: string }
  | { dollars: number | null; cents?: never; className?: string };

/**
 * Renders a currency value with tabular figures so digits align in table
 * columns. Pass `cents` for integer-cent values (preferred), or `dollars` for
 * a decimal USD amount. The unit is explicit in the prop name — there is no
 * unit-ambiguous `value` prop.
 */
export function Currency(props: CurrencyProps & { className?: string }) {
  const { className } = props;
  const text =
    props.cents != null
      ? formatCurrencyCents(props.cents)
      : formatCurrency(props.dollars);
  return <span className={`tabular-nums${className ? ` ${className}` : ""}`}>{text}</span>;
}
