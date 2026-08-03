import type { ReactNode } from "react";

/**
 * Pins whatever's inside — area nav, PageHeader, section SubNav/TabBar — to
 * the top of the page's scroll container so only the content below it
 * scrolls. The single shared mechanism for "title + subtabs stay put while
 * scrolling" (see docs/UI_STANDARD.md §4); pages compose it once instead of
 * hand-rolling sticky offsets.
 *
 * `divider`: a page with no subtab bar underneath its title has nothing to
 * supply the border a TabBar/SubNav row draws for free — pass this so the
 * frozen header still reads as visually distinct from the scrollable
 * content below it.
 */
export default function StickyHeader({ children, divider = false }: { children: ReactNode; divider?: boolean }) {
  return (
    <div className={`sticky top-0 z-40 bg-canvas pt-4 sm:pt-8 ${divider ? "pb-4 border-b border-line" : ""}`}>
      {children}
    </div>
  );
}
