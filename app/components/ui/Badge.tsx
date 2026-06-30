import { type ReactNode } from "react";
import { TONE_SOFT, type Tone } from "./tone";

/**
 * Status pill. Canonical size `text-xs px-2 py-0.5 rounded-full`, color via `tone`.
 * Replaces per-feature badge color maps.
 */
export default function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${TONE_SOFT[tone]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
