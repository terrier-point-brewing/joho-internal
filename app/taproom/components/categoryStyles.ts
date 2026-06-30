// Deliberate data-category color ramps for the taproom feature. These are NOT
// semantic status tones (use Badge/tone.ts for those) — they encode an ordered
// "days remaining" urgency scale where the hue itself carries meaning. Per
// UI_STANDARD §2/§6 such category palettes stay as fixed hues but must live in
// one shared constant instead of being inlined per component.

export type DraftUrgency =
  | "critical"
  | "low"
  | "watch"
  | "soon"
  | "good"
  | "retiring"
  | "retired"
  | "none";

/** Tap card border + background by urgency tier. */
export const DRAFT_URGENCY_CARD: Record<DraftUrgency, string> = {
  critical: "border-red-500     bg-red-950/25",
  low:      "border-orange-500  bg-orange-950/20",
  watch:    "border-amber-500   bg-amber-950/15",
  soon:     "border-yellow-500/70 bg-yellow-950/10",
  good:     "border-green-700/60 bg-green-950/10",
  retiring: "border-line-strong border-dashed",
  retired:  "border-line opacity-55",
  none:     "border-line",
};

/** Urgency badge wrap + text colors (only the alerting tiers carry a badge). */
export const DRAFT_URGENCY_BADGE: Partial<Record<DraftUrgency, { wrap: string; text: string }>> = {
  critical: { wrap: "bg-red-950/60 border-red-500/70",       text: "text-red-400"    },
  low:      { wrap: "bg-orange-950/50 border-orange-500/60", text: "text-orange-400" },
  watch:    { wrap: "bg-amber-950/40 border-amber-500/50",   text: "text-amber-400"  },
  soon:     { wrap: "bg-yellow-950/30 border-yellow-600/50", text: "text-yellow-400" },
};

export const DRAFT_URGENCY_LABEL: Partial<Record<DraftUrgency, string>> = {
  critical: "Critical",
  low:      "Low",
  watch:    "Watch",
  soon:     "Soon",
};

/** "days left" stat text color by urgency tier. */
export const DRAFT_URGENCY_DAYS_TEXT: Record<DraftUrgency, string> = {
  critical: "text-red-400",
  low:      "text-orange-400",
  watch:    "text-amber-400",
  soon:     "text-yellow-400",
  good:     "text-success",
  retiring: "text-faint",
  retired:  "text-faint",
  none:     "text-faint",
};
