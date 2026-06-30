import { formatPercent } from "@/lib/format";

type PercentProps = {
  /** Ratio value — `0.15` renders as `15.0%`. */
  value?: number | null;
  /** Fixed number of decimal places (default 1). */
  decimals?: number;
  className?: string;
};

/**
 * Renders a ratio as a percentage with tabular figures so digits align in
 * table columns. `Intl` multiplies by 100, so pass `0.15` to render `15.0%`.
 */
export function Percent({ value, decimals = 1, className }: PercentProps) {
  return (
    <span className={`tabular-nums${className ? ` ${className}` : ""}`}>
      {formatPercent(value, decimals)}
    </span>
  );
}
