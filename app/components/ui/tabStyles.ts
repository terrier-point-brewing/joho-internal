// Single source for the underline-tab visual language, shared by SubNav (link-driven)
// and TabBar (button-driven) so the markup can't drift. See docs/UI_STANDARD.md §5.

/** Tab row container. */
export const TAB_ROW =
  "flex gap-1 border-b border-line overflow-x-auto overflow-y-hidden scrollbar-none";

/** Sticky offset for a tab row pinned under the mobile top bar. */
export const TAB_STICKY = "sticky top-11 md:static z-40 bg-canvas/95";

/** Per-item class for an underline tab. */
export function tabItem(active: boolean): string {
  return `px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
    active
      ? "text-accent border-accent-emphasis"
      : "text-muted border-transparent hover:text-body"
  }`;
}
