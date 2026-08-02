import type { ReactNode } from "react";

/**
 * Pins whatever's inside — area nav, PageHeader, section SubNav/TabBar — to
 * the top of the page's scroll container so only the content below it
 * scrolls. The single shared mechanism for "title + subtabs stay put while
 * scrolling" (see docs/UI_STANDARD.md §4); pages compose it once instead of
 * hand-rolling sticky offsets.
 */
export default function StickyHeader({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-40 bg-canvas pt-4 sm:pt-8">
      {children}
    </div>
  );
}
