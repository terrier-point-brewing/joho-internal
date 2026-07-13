// Shared channel palette for the consolidated Financials view. Channel is a
// data-category dimension (per docs/UI_STANDARD.md §2/§6 this is the one
// deliberate exception to the no-raw-colors rule) -- keep every raw color
// here, in this single file, never inlined per cell. Hues mirror
// app/production/lib/categoryColors.ts's CHANNEL_COLOR (taproom blue,
// distribution emerald, contract_brewing purple, wholesale amber) so the
// same channel reads the same color across Production and Finance; that
// file's Channel-like union doesn't cover "events"/"unknown" though, so this
// is its own map keyed off lib/finance/financials/types.ts's Channel type.

import type { Channel } from "@/lib/finance/financials/types";

export const CHANNEL_LABEL: Record<Channel, string> = {
  taproom: "Taproom",
  events: "Events",
  contract_brewing: "Contract Brewing",
  distribution: "Distribution",
  wholesale: "Wholesale",
  unknown: "Unknown",
};

export const CHANNEL_COLOR: Record<Channel, { bg: string; text: string }> = {
  taproom:          { bg: "bg-blue-900/50",    text: "text-blue-300" },
  events:           { bg: "bg-teal-900/50",    text: "text-teal-300" },
  contract_brewing: { bg: "bg-purple-900/50",  text: "text-purple-300" },
  distribution:     { bg: "bg-emerald-900/50", text: "text-emerald-300" },
  wholesale:        { bg: "bg-amber-900/50",   text: "text-amber-300" },
  unknown:          { bg: "bg-surface-mid",    text: "text-secondary" },
};
