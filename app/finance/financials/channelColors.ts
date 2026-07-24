// Shared channel palette for the consolidated Financials view. Channel is a
// data-category dimension (per docs/UI_STANDARD.md §2/§6 this is the one
// deliberate exception to the no-raw-colors rule) -- keep every raw color
// here, in this single file, never inlined per cell. Hues mirror
// app/production/lib/categoryColors.ts's CHANNEL_COLOR (taproom blue,
// distribution emerald, contract_brewing purple, wholesale amber) so the
// same channel reads the same color across Production and Finance; that
// file's Channel-like union doesn't cover "events"/"unknown" though, so this
// is its own map keyed off lib/finance/financials/types.ts's Channel type.
//
// Colors come from the theme-flipping category tokens (--cat-{hue}-{bg,fg,bd},
// defined in app/globals.css with dark defaults + light values emitted by
// lib/brand/opsThemeMap.ts's CAT_RAMP). This mirrors production's
// CATEGORY_BADGE_CLASS so the channel pills stay legible when the brand skin
// is toggled to light mode instead of showing light-text-on-light.

import type { Channel } from "@/lib/finance/financials/types";

export const CHANNEL_LABEL: Record<Channel, string> = {
  taproom: "Taproom",
  events: "Events",
  contract_brewing: "Contract Brewing",
  distribution: "Distribution",
  wholesale: "Wholesale",
  unknown: "Unknown",
};

export const CHANNEL_COLOR: Record<Channel, { bg: string; text: string; border: string }> = {
  taproom:          { bg: "bg-[var(--cat-blue-bg)]",    text: "text-[var(--cat-blue-fg)]",    border: "border-[var(--cat-blue-bd)]" },
  events:           { bg: "bg-[var(--cat-teal-bg)]",    text: "text-[var(--cat-teal-fg)]",    border: "border-[var(--cat-teal-bd)]" },
  contract_brewing: { bg: "bg-[var(--cat-purple-bg)]",  text: "text-[var(--cat-purple-fg)]",  border: "border-[var(--cat-purple-bd)]" },
  distribution:     { bg: "bg-[var(--cat-emerald-bg)]", text: "text-[var(--cat-emerald-fg)]", border: "border-[var(--cat-emerald-bd)]" },
  wholesale:        { bg: "bg-[var(--cat-amber-bg)]",   text: "text-[var(--cat-amber-fg)]",   border: "border-[var(--cat-amber-bd)]" },
  unknown:          { bg: "bg-surface-mid",             text: "text-secondary",               border: "border-line-subtle" },
};
