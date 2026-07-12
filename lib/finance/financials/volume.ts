// Pure derivation of a row's BBL volume + coverage flag, and the gated
// $/BBL ratio. `$/BBL` is a ratio measure — a mis-parsed BBL denominator
// would silently mislead — so `amountPerBbl` NEVER divides on partial/
// unknown coverage. No DB, no Square calls, no React. See spec §5 rider.

import type { BblCoverage } from "./types";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { GALLONS_PER_BBL, BBL_TO_FL_OZ } from "@/lib/constants/production";

// Physical keg-size -> gallons table. Mirrors the private KEG_GALLONS map in
// lib/reports/bbl-tracker.ts (not exported there, so duplicated here as a
// constant lookup only). The *parsing* of keg-size tokens from variation
// names is NOT re-implemented here — callers pass the already-parsed enum
// produced by lib/reports/kegs.ts's parseKegSizeToken (also used by
// lib/finance/financials/dimensions.ts's deriveKegSize).
const KEG_SIZE_GALLONS: Record<"half" | "quarter" | "sixth", number> = {
  half: 15.5,
  quarter: 7.75,
  sixth: 5.167,
};

// Beer/volume-bearing Square reporting categories, per the shared
// CATEGORY_IDS constant (lib/constants/categories.ts) — the single source of
// truth the rest of the codebase uses to decide a row is volume-bearing.
const VOLUME_CATEGORY_IDS: ReadonlySet<string> = new Set<string>([
  ...CATEGORY_IDS.DRAFT,
  ...CATEGORY_IDS.KEGS,
  ...CATEGORY_IDS.CANS,
]);

export type BblSourceRow =
  // Invoice/export rows: BBL comes straight from export_transactions.volume_bbl.
  | { kind: "invoice"; volumeBbl: number }
  // Taproom (POS) rows: BBL is derived from the sold variation.
  | {
      kind: "taproom";
      categoryId: string | null;
      kegSize: "half" | "quarter" | "sixth" | "can" | null;
      variationName: string | null;
      quantity: number;
    };

export function rowBbl(row: BblSourceRow): { bbl: number; coverage: BblCoverage } {
  if (row.kind === "invoice") {
    return { bbl: row.volumeBbl, coverage: "full" };
  }

  const isBeerRow = row.categoryId !== null && VOLUME_CATEGORY_IDS.has(row.categoryId);
  if (!isBeerRow) {
    // Legitimately volume-less (merch, snacks, liquor, etc.) — known, not unknown.
    return { bbl: 0, coverage: "full" };
  }

  if (row.kegSize === "half" || row.kegSize === "quarter" || row.kegSize === "sixth") {
    const gallons = KEG_SIZE_GALLONS[row.kegSize] * row.quantity;
    return { bbl: gallons / GALLONS_PER_BBL, coverage: "full" };
  }

  if (row.kegSize === "can" && row.variationName) {
    const totalOz = canOzPerUnit(row.variationName) * row.quantity;
    return { bbl: totalOz / BBL_TO_FL_OZ, coverage: "full" };
  }

  // Beer/volume-bearing row whose BBL cannot be derived from what we have.
  return { bbl: 0, coverage: "unknown" };
}

export function amountPerBbl(
  amountCents: number,
  bbl: number,
  coverage: BblCoverage
): { valueCents: number | null; flagged: boolean } {
  if (coverage !== "full" || bbl <= 0) {
    return { valueCents: null, flagged: true };
  }
  return { valueCents: Math.round(amountCents / bbl), flagged: false };
}
