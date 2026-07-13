// Pure derivation of the orthogonal operational dimensions (channel / POS
// category / keg size) that the consolidated financials view groups
// CoA-mapped rows by. No DB, no Square calls, no React — see spec §5.

import type { Channel } from "./types";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { parseKegSizeToken } from "@/lib/reports/kegs";

// export_transactions.channel values that map 1:1 onto Channel. Anything
// else (missing/unrecognized) falls back to "unknown".
const EXPORT_CHANNELS: ReadonlySet<string> = new Set<Channel>([
  "contract_brewing",
  "distribution",
  "wholesale",
]);

export function deriveChannel(row: {
  invoiceId: string | null;
  isEventPour: boolean;
  exportChannel: string | null;
}): Channel {
  if (row.isEventPour) return "events";
  if (row.invoiceId === null) return "taproom";
  if (row.exportChannel && EXPORT_CHANNELS.has(row.exportChannel)) {
    return row.exportChannel as Channel;
  }
  return "unknown";
}

// Maps a variation's Square reporting-category id to the shared Taproom
// Model category id (e.g. "DRAFT_BEER", "CANS"). Reuses
// TAPROOM_MODEL_CATEGORIES from lib/constants/categories — do not invent a
// parallel category grouping here.
export function derivePosCategory(variation: { categoryId: string | null }): string | null {
  if (!variation.categoryId) return null;
  const match = TAPROOM_MODEL_CATEGORIES.find((c) =>
    (c.squareCats as readonly string[]).includes(variation.categoryId as string)
  );
  return match ? match.id : null;
}

// Derives the packaging size from a raw variation name. Keg fractions
// ("1/2 Keg", "1/4 Keg", "1/6 Keg") are parsed via the shared
// lib/reports/kegs.ts helper (single source of truth for that token — do
// not re-parse it here). "can" has no equivalent shared name-parser
// elsewhere in the codebase (lib/reports/bbl-tracker.ts detects cans via
// Square category id, not the variation name), so it's matched directly by
// keyword.
export function deriveKegSize(variationName: string): "half" | "quarter" | "sixth" | "can" | null {
  const kegSize = parseKegSizeToken(variationName);
  if (kegSize) return kegSize;
  if (/\bcan\b/i.test(variationName)) return "can";
  return null;
}
