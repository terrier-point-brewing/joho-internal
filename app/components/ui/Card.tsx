import { type ReactNode } from "react";

/**
 * Canonical surface panel: `bg-surface border border-line rounded-lg`.
 * Replaces hand-rolled card divs. Inner padding via `padding` (default `p-4`).
 */
export default function Card({
  children,
  className = "",
  padding = "p-4",
}: {
  children: ReactNode;
  className?: string;
  /** Tailwind padding utility(ies); pass "" for no padding (e.g. tables). */
  padding?: string;
}) {
  return (
    <div className={`bg-surface border border-line rounded-lg ${padding} ${className}`.trim()}>
      {children}
    </div>
  );
}
