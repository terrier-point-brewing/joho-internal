// Deliberate data-category color ramps for the taproom feature. These are NOT
// semantic status tones (use Badge/tone.ts for those) — they encode an ordered
// "days remaining" urgency scale where the hue itself carries meaning. Per
// UI_STANDARD §2/§6 such category palettes stay as fixed hues but must live in
// one shared constant instead of being inlined per component.
//
// Three tiers only — good → low → critical — kept visually distinct with a
// green/amber/red traffic-light ramp. `retired` is not a step on that ramp: a
// retired tap keeps its normal good/low coloring while it still has beer and
// only renders in the greyed, dashed "retired" style once it reaches critical
// (empty / ≤3 days), since a retired keg is meant to blow, not be reordered.
// `fresh` is a tap with beer on hand but no pours recorded yet — it has no
// pour rate to forecast from, so it is neither good nor critical; it renders
// neutral with a "New" badge until the first pour lands.

export type DraftUrgency =
  | "critical"
  | "low"
  | "good"
  | "fresh"
  | "retired"
  | "none";

/** Tap card border + background by urgency tier. */
export const DRAFT_URGENCY_CARD: Record<DraftUrgency, string> = {
  critical: "border-red-500      bg-red-950/25",
  low:      "border-amber-500    bg-amber-950/20",
  good:     "border-green-700/60 bg-green-950/10",
  fresh:    "border-sky-700/60   bg-sky-950/10",
  retired:  "border-line-strong border-dashed opacity-55",
  none:     "border-line",
};

/** Urgency badge wrap + text colors (only the alerting tiers carry a badge). */
export const DRAFT_URGENCY_BADGE: Partial<Record<DraftUrgency, { wrap: string; text: string }>> = {
  critical: { wrap: "bg-red-950/60 border-red-500/70",    text: "text-red-400"   },
  low:      { wrap: "bg-amber-950/50 border-amber-500/60", text: "text-amber-400" },
  fresh:    { wrap: "bg-sky-950/50 border-sky-500/50",     text: "text-sky-300"   },
};

export const DRAFT_URGENCY_LABEL: Partial<Record<DraftUrgency, string>> = {
  critical: "Critical",
  low:      "Low",
  fresh:    "New",
};

/** "days left" stat text color by urgency tier. */
export const DRAFT_URGENCY_DAYS_TEXT: Record<DraftUrgency, string> = {
  critical: "text-red-400",
  low:      "text-amber-400",
  good:     "text-success",
  fresh:    "text-faint",
  retired:  "text-faint",
  none:     "text-faint",
};
