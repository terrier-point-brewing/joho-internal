import { type ReactNode } from "react";
import { TONE_SOFT, type Tone } from "./tone";

/**
 * Status pill. Canonical size `text-xs px-2 py-0.5 rounded-full`, color via `tone`.
 * Replaces per-feature badge color maps.
 *
 * `tone="none"` emits no color classes, for the sanctioned data-category exception
 * where the caller supplies its own palette through `className` (channel colors, GL
 * category colors). Without it the tone's classes and the caller's would both apply
 * and Tailwind would resolve the winner by stylesheet order, not by className order.
 */
export default function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone | "none";
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${
        tone === "none" ? "" : TONE_SOFT[tone]
      } ${className}`.trim()}
    >
      {children}
    </span>
  );
}
