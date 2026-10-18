import { type ReactNode } from "react";

/**
 * Canonical surface panel: `bg-surface border border-line rounded-lg`.
 * Replaces hand-rolled card divs. Inner padding via `padding` (default `p-4`).
 *
 * `scroll="x"` makes the card the horizontal scroll container for a wide
 * table (`.scroll-x`: hidden scrollbar, contained swipe, overflow fade) so
 * the table never spills past the page on a phone. Pair with `padding=""`.
 * `bleed` additionally lets the card run edge-to-edge below `sm` — the
 * standard's mobile bleed (`-mx-4 sm:mx-0`, docs/UI_STANDARD.md §3) — for a
 * table that sits directly in a `px-4` page, never for one inside a modal.
 */
export default function Card({
  children,
  className = "",
  padding = "p-4",
  scroll,
  bleed = false,
  title,
}: {
  children: ReactNode;
  className?: string;
  /** Tailwind padding utility(ies); pass "" for no padding (e.g. tables). */
  padding?: string;
  scroll?: "x";
  bleed?: boolean;
  /** Hover text for the whole card (a tile's rule or caveat). */
  title?: string;
}) {
  const scrollCls = scroll === "x" ? "scroll-x" : "";
  const bleedCls = bleed ? "-mx-4 sm:mx-0 max-sm:rounded-none max-sm:border-x-0" : "";
  return (
    <div title={title} className={`bg-surface border border-line rounded-lg ${padding} ${scrollCls} ${bleedCls} ${className}`.replace(/\s+/g, " ").trim()}>
      {children}
    </div>
  );
}
