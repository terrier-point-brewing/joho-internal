import { type ReactNode } from "react";
import { TONE_SOFT, type Tone } from "./tone";

/**
 * Inline alert / message box. Replaces the ~12 copy-pasted error banners.
 * Default tone is `danger` (the most common use). Renders nothing if no children.
 */
export default function Banner({
  children,
  tone = "danger",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  if (!children) return null;
  return (
    <div
      className={`text-sm rounded-md border px-3 py-2 ${TONE_SOFT[tone]} ${className}`.trim()}
      role={tone === "danger" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}
