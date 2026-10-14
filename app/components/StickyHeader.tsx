import { Children, isValidElement, type ReactNode } from "react";

/**
 * Pins whatever's inside — PageHeader, section SubNav/TabBar — to the top of
 * the page's scroll container so only the content below it scrolls. The
 * single shared mechanism for "title + subtabs stay put while scrolling"
 * (see docs/UI_STANDARD.md §4); pages compose it once instead of
 * hand-rolling sticky offsets.
 *
 * The area nav (`<SubNav mobile />`, or a section wrapper passing `mobile`)
 * is still passed as a child, but it is lifted OUT of the frozen block and
 * rendered above it: on a phone the frozen header was 192px — a third of the
 * screen — and the area tabs are the one row that doesn't need to follow the
 * reader (the bottom nav already reaches every section). Callers don't
 * change; the component decides what freezes.
 *
 * `divider`: a page with no subtab bar underneath its title has nothing to
 * supply the border a TabBar/SubNav row draws for free — pass this so the
 * frozen header still reads as visually distinct from the scrollable
 * content below it.
 */
export default function StickyHeader({ children, divider = false }: { children: ReactNode; divider?: boolean }) {
  const areaNav: ReactNode[] = [];
  const frozen: ReactNode[] = [];
  Children.forEach(children, (child) => {
    const isAreaNav = isValidElement(child) && (child.props as { mobile?: boolean }).mobile === true;
    (isAreaNav ? areaNav : frozen).push(child);
  });
  return (
    <>
      {areaNav.length > 0 && <div className="pt-2 md:hidden">{areaNav}</div>}
      <div className={`sticky top-0 z-40 bg-canvas pt-2 sm:pt-8 ${divider ? "pb-4 border-b border-line" : ""}`}>
        {frozen}
      </div>
    </>
  );
}
