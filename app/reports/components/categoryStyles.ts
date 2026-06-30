// Deliberate data-category color palettes shared across report tables. These
// hues encode a *category* (line type, sales channel) rather than a semantic
// status, so per UI_STANDARD §2/§6 they stay as fixed hues but are centralized
// here instead of being inlined per report.

/** Cocktail-sales line type pill colors — Combo (purple) vs Single (blue). */
export const COCKTAIL_TYPE_BADGE = {
  combo:  "bg-purple-900 text-purple-200",
  single: "bg-blue-900 text-blue-200",
} as const;

/**
 * BBL-tracker channel column text colors. Distribution = blue, Contract =
 * purple; both have a muted/empty fallback. Taproom columns use neutral text.
 */
export const BBL_CHANNEL_TEXT = {
  dist:     { on: "text-blue-300",   off: "text-faint" },
  contract: { on: "text-purple-300", off: "text-faint" },
} as const;
