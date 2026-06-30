import { formatNumber } from "@/lib/format";

type NumberProps = {
  value?: number | null;
  /** Fixed number of decimal places (default 0). */
  decimals?: number;
  className?: string;
};

/**
 * Renders a number with grouping separators and tabular figures so digits
 * align in table columns.
 */
export function Number({ value, decimals = 0, className }: NumberProps) {
  return (
    <span className={`tabular-nums${className ? ` ${className}` : ""}`}>
      {formatNumber(value, decimals)}
    </span>
  );
}
