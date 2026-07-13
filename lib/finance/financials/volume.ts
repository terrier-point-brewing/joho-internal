// Pure derivation of a row's BBL volume + coverage flag, and the gated
// $/BBL ratio. `$/BBL` is a ratio measure — a mis-parsed BBL denominator
// would silently mislead — so `amountPerBbl` NEVER divides on partial/
// unknown coverage. No DB, no Square calls, no React. See spec §5 rider.

import type { BblCoverage } from "./types";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { canOzPerUnit, parseFlOz } from "@/lib/reports/bbl-tracker";
import { GALLONS_PER_BBL, BBL_TO_FL_OZ, KEG_GALLONS_BY_SIZE } from "@/lib/constants/production";

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
      /** pos_line_items.net_sales_cents — needed to detect keg-transfer rows (see isKegTransfer below). */
      netSalesCents: number;
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

  // By-the-glass draft pours (dominant taproom volume): identified by Square
  // reporting category, not kegSize — a draft pour has no keg-fraction/can
  // token, so it fell through to "unknown" pre-fix. Mirrors the deleted
  // taproom route's parseFlOz(variationName) * quantity / BBL_TO_FL_OZ.
  const isDraft = row.categoryId !== null && CATEGORY_IDS.DRAFT.has(row.categoryId);
  if (isDraft) {
    // A null variationName still means "known draft pour, unknown exact
    // size" — default to 16oz (the same default parseFlOz uses internally
    // for a named-but-oz-less variation) rather than falling through to
    // "unknown". The whole DRAFT group shares one aggregation key, so an
    // "unknown" here would propagate via mergeCoverage and withhold $/BBL
    // for the ~99%-known draft aggregate over one ambiguous row.
    const flOz = row.variationName ? parseFlOz(row.variationName) : 16;
    const totalOz = flOz * row.quantity;
    return { bbl: totalOz / BBL_TO_FL_OZ, coverage: "full" };
  }

  // Keg-transfer detection: a KEGS-category row is the taproom's internal
  // record of moving a whole keg onto tap so it can be poured by the glass
  // — it is NOT a sale, and its volume is already counted when poured as a
  // DRAFT_BEER by-the-glass row above. The old (pre-consolidation) taproom
  // route excluded these via an explicit "Keg Transfer" 100%-discount
  // signal (isTransfer), but lib/finance/syncPosTransactions.ts never
  // persists that signal into pos_line_items, so this pipeline can't see it
  // directly. net_sales_cents === 0 on a KEGS row is the persisted
  // fingerprint of that same signal (a transfer nets to $0; a real keg sale
  // never does) — it is a KNOWN zero, not an unknown/unparseable row.
  // Hardening idea for later: persist an explicit is_transfer flag on
  // pos_line_items at sync time instead of inferring it from net_sales_cents.
  const isKegs = row.categoryId !== null && CATEGORY_IDS.KEGS.has(row.categoryId);
  if (isKegs && row.netSalesCents === 0) {
    return { bbl: 0, coverage: "full" };
  }

  if (row.kegSize === "half" || row.kegSize === "quarter" || row.kegSize === "sixth") {
    const gallons = KEG_GALLONS_BY_SIZE[row.kegSize] * row.quantity;
    return { bbl: gallons / GALLONS_PER_BBL, coverage: "full" };
  }

  // Cans, identified by Square reporting category rather than kegSize ===
  // "can" — deriveKegSize's "can" token only matches variation names
  // containing the literal word "can" (e.g. "Single Can"), missing names
  // like "16oz 4-Pack" that are unambiguously cans by category.
  const isCans = row.categoryId !== null && CATEGORY_IDS.CANS.has(row.categoryId);
  if (isCans && row.variationName) {
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
