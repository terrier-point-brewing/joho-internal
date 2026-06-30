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
 * soft tinted bg + light text + mid border. Keyed by category hue name.
 */
export const CATEGORY_BADGE_CLASS = {
  amber:   "bg-amber-900/50 text-amber-300 border-amber-700",
  blue:    "bg-blue-900/50 text-blue-300 border-blue-700",
  purple:  "bg-purple-900/50 text-purple-300 border-purple-700",
  emerald: "bg-emerald-900/50 text-emerald-300 border-emerald-700",
  cyan:    "bg-cyan-900/50 text-cyan-300 border-cyan-700",
  orange:  "bg-orange-900/50 text-orange-300 border-orange-700",
  rose:    "bg-rose-900/50 text-rose-300 border-rose-700",
  sky:     "bg-sky-900/50 text-sky-300 border-sky-700",
  teal:    "bg-teal-900/50 text-teal-300 border-teal-700",
  yellow:  "bg-yellow-900/50 text-yellow-300 border-yellow-700",
  green:   "bg-green-900/50 text-green-300 border-green-700",
  red:     "bg-red-900/50 text-red-300 border-red-700",
  neutral: "bg-surface-mid text-secondary border-line-subtle",
  muted:   "bg-surface border-line-strong text-muted",
} as const;

/** Shared "Keg" tag pill (orange) — repeated across packaging/export views. */
export const KEG_TAG_BADGE = "border border-orange-700 bg-orange-900/30 text-orange-300";

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
  kegging:    "text-orange-400",
  canning:    "text-cyan-400",
  export:     "text-purple-400",
  conversion: "text-accent",
};

/**
 * Allocation-channel colors: badge bg/text classes + a hex `bar` for stacked bars.
 * Shared by BatchLog badges and the demand/allocation charts.
 */
export const CHANNEL_COLOR: Record<string, { bg: string; text: string; bar: string }> = {
  taproom:          { bg: "bg-blue-900/50",    text: "text-blue-300",    bar: "#3b82f6" },
  distribution:     { bg: "bg-emerald-900/50", text: "text-emerald-300", bar: "#10b981" },
  contract_brewing: { bg: "bg-purple-900/50",  text: "text-purple-300",  bar: "#8b5cf6" },
  wholesale:        { bg: "bg-amber-900/50",   text: "text-amber-300",   bar: "#f59e0b" },
  safety_stock:     { bg: "bg-surface-mid",    text: "text-secondary",   bar: "#52525b" },
};
