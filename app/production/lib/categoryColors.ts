// Shared data-category color palettes for production.
//
// These are *category* colors (batch identity, equipment type, allocation channel,
// transfer type, batch status) — deliberate multi-hue palettes, NOT semantic tones.
// Per docs/UI_STANDARD.md §2/§6 they are centralized here rather than copy-pasted per
// file. Hues are preserved; only duplication is removed.
//
// Two flavors live here:
//  • Hex palettes for canvas / inline-style consumers (Gantt, Calendar, stacked bars).
//  • Tailwind class maps for badge pills (soft bg + text + border convention).

/** 12-color cycle for per-batch identity coloring (Gantt bars + Calendar pills). */
export const BATCH_PALETTE = [
  "#f59e0b", "#3b82f6", "#10b981", "#8b5cf6",
  "#f43f5e", "#06b6d4", "#f97316", "#14b8a6",
  "#a855f7", "#84cc16", "#ec4899", "#6366f1",
] as const;

/** Neutral fallback used when no batch/category color is resolved. */
export const CATEGORY_FALLBACK_HEX = "#6b7280";

/** Left-border accent hex per equipment type (Gantt group-header rows). */
export const EQUIPMENT_TYPE_ACCENT_HEX: Record<string, string> = {
  brewhouse:    "#f59e0b", // amber
  fermenter:    "#3b82f6", // blue
  brite:        "#8b5cf6", // purple
  kegging:      "#10b981", // emerald
  canning:      "#06b6d4", // cyan
  cold_storage: "#6b7280", // gray
};

/**
 * Badge class convention shared by status / transfer-type / channel pills:
 * soft tinted bg + readable text + mid border. Keyed by category hue name.
 *
 * Hue entries bind to the theme-flipping `--cat-{hue}-*` tokens (dark defaults
 * in app/globals.css, light values emitted by BrandChrome) so a badge reads on
 * both the dark ops canvas and the light brand skin. `neutral`/`muted` already
 * ride semantic surface/text tokens, which flip on their own.
 */
export const CATEGORY_BADGE_CLASS = {
  amber:   "bg-[var(--cat-amber-bg)] text-[var(--cat-amber-fg)] border-[var(--cat-amber-bd)]",
  blue:    "bg-[var(--cat-blue-bg)] text-[var(--cat-blue-fg)] border-[var(--cat-blue-bd)]",
  purple:  "bg-[var(--cat-purple-bg)] text-[var(--cat-purple-fg)] border-[var(--cat-purple-bd)]",
  emerald: "bg-[var(--cat-emerald-bg)] text-[var(--cat-emerald-fg)] border-[var(--cat-emerald-bd)]",
  cyan:    "bg-[var(--cat-cyan-bg)] text-[var(--cat-cyan-fg)] border-[var(--cat-cyan-bd)]",
  orange:  "bg-[var(--cat-orange-bg)] text-[var(--cat-orange-fg)] border-[var(--cat-orange-bd)]",
  rose:    "bg-[var(--cat-rose-bg)] text-[var(--cat-rose-fg)] border-[var(--cat-rose-bd)]",
  sky:     "bg-[var(--cat-sky-bg)] text-[var(--cat-sky-fg)] border-[var(--cat-sky-bd)]",
  teal:    "bg-[var(--cat-teal-bg)] text-[var(--cat-teal-fg)] border-[var(--cat-teal-bd)]",
  yellow:  "bg-[var(--cat-yellow-bg)] text-[var(--cat-yellow-fg)] border-[var(--cat-yellow-bd)]",
  green:   "bg-[var(--cat-green-bg)] text-[var(--cat-green-fg)] border-[var(--cat-green-bd)]",
  red:     "bg-[var(--cat-red-bg)] text-[var(--cat-red-fg)] border-[var(--cat-red-bd)]",
  neutral: "bg-surface-mid text-secondary border-line-subtle",
  muted:   "bg-surface border-line-strong text-muted",
} as const;

/** Shared "Keg" tag pill (orange) — repeated across packaging/export views. */
export const KEG_TAG_BADGE =
  "border bg-[var(--cat-orange-bg)] text-[var(--cat-orange-fg)] border-[var(--cat-orange-bd)]";

export type CategoryHue = keyof typeof CATEGORY_BADGE_CLASS;

/** Transfer-type badge classes (brewing/transfers log). */
export const TRANSFER_TYPE_BADGE: Record<string, string> = {
  transfer:   CATEGORY_BADGE_CLASS.neutral,
  kegging:    CATEGORY_BADGE_CLASS.emerald,
  canning:    CATEGORY_BADGE_CLASS.cyan,
  conversion: CATEGORY_BADGE_CLASS.amber,
  export:     CATEGORY_BADGE_CLASS.purple,
  brewing:    CATEGORY_BADGE_CLASS.blue,
};

/** Transfer-type inline text color (category hues), for dense log cells. */
export const TRANSFER_TYPE_TEXT: Record<string, string> = {
  brewing:    "text-success",
  transfer:   "text-info",
  kegging:    "text-[var(--cat-orange-fg)]",
  canning:    "text-[var(--cat-cyan-fg)]",
  export:     "text-[var(--cat-purple-fg)]",
  conversion: "text-accent",
};

/**
 * Allocation-channel colors: badge bg/text/border classes + a hex `bar` for
 * stacked bars. The class fields bind to the theme-flipping `--cat-{hue}-*`
 * tokens so channel pills read on both themes; `bar` stays a raw hex because it
 * paints Recharts/canvas series (an exempt surface). Shared by BatchLog badges,
 * Commitments/Export channel pills, and the demand/allocation charts.
 */
export const CHANNEL_COLOR: Record<
  string,
  { bg: string; text: string; border: string; bar: string }
> = {
  taproom:          { bg: "bg-[var(--cat-blue-bg)]",    text: "text-[var(--cat-blue-fg)]",    border: "border-[var(--cat-blue-bd)]",    bar: "#3b82f6" },
  distribution:     { bg: "bg-[var(--cat-emerald-bg)]", text: "text-[var(--cat-emerald-fg)]", border: "border-[var(--cat-emerald-bd)]", bar: "#10b981" },
  contract_brewing: { bg: "bg-[var(--cat-purple-bg)]",  text: "text-[var(--cat-purple-fg)]",  border: "border-[var(--cat-purple-bd)]",  bar: "#8b5cf6" },
  wholesale:        { bg: "bg-[var(--cat-amber-bg)]",   text: "text-[var(--cat-amber-fg)]",   border: "border-[var(--cat-amber-bd)]",   bar: "#f59e0b" },
  safety_stock:     { bg: "bg-surface-mid",             text: "text-secondary",               border: "border-line-subtle",             bar: "#52525b" },
};
