/**
 * BBL Tracker — tracks beer production volume by style and distribution channel.
 *
 * Channels:
 *   TAPROOM_DRAFT     — kegs consumed as draft via "Keg Transfer" discount (POS orders)
 *   TAPROOM_PACKAGED  — kegs + cans sold at taproom (POS orders, no transfer discount)
 *   DISTRIBUTION      — kegs + cans on invoice orders with no contract-brewing items
 *   CONTRACT_BREWING  — kegs + cans on invoice orders that also have contract-brewing items
 *
 * Volume constants (US):
 *   1 BBL = 31 gallons
 *   1/2 Keg = 15.5 gal  | 1/4 Keg = 7.75 gal  | 1/6 Keg = 5.167 gal
 *   Cans: volume parsed from variation name (e.g. "16oz 4-Pack" = 4 × 16 oz)
 *
 * Excise tax (NC craft brewery rates):
 *   State: $0.6171 / gallon
 *   Federal: $3.50 / BBL
 */

import type { CatalogItem, Order } from "@/types/square";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import { GALLONS_PER_BBL, KEG_GALLONS_BY_SIZE } from "@/lib/constants/production";
import { mapDiscountsByUid } from "@/lib/utils/orders";

const KEG_GALLONS: Record<string, number> = {
  "1/2 Keg": KEG_GALLONS_BY_SIZE.half,
  "1/4 Keg": KEG_GALLONS_BY_SIZE.quarter,
  "1/6 Keg": KEG_GALLONS_BY_SIZE.sixth,
};

const STATE_EXCISE_PER_GALLON = 0.6171; // NC
const FEDERAL_EXCISE_PER_BBL  = 3.50;

const KEG_SIZE_PATTERN = /^\d+\/\d+ Keg$/;

// ---------------------------------------------------------------------------
// Can volume parser
// ---------------------------------------------------------------------------

/** Returns total oz for one sold unit of the given can variation. */
export function canOzPerUnit(variationName: string): number {
  const ozMatch    = variationName.match(/(\d+)oz/i);
  const ozPerCan   = ozMatch ? parseInt(ozMatch[1]) : 16; // default 16 oz

  if (/case/i.test(variationName))   return ozPerCan * 24;
  if (/12-?pack/i.test(variationName)) return ozPerCan * 12;
  if (/6-?pack/i.test(variationName))  return ozPerCan * 6;
  if (/4-?pack/i.test(variationName))  return ozPerCan * 4;
  return ozPerCan; // single can
}

/**
 * Returns fl oz for one sold unit of a by-the-glass draft-pour variation
 * (e.g. "Draft - 16oz" -> 16; "16oz" -> 16; default 16 when unparseable).
 * Shared with lib/finance/financials/volume.ts's rowBbl -- single source of
 * truth for draft-pour fl-oz parsing (mirrors the deleted taproom route's
 * parseFlOz, which this restores after a Square-parity volume-derivation
 * bug: draft pours never derived a BBL).
 */
export function parseFlOz(variationName: string): number {
  const m = variationName.match(/(\d+)\s*oz/i);
  return m ? parseInt(m[1], 10) : 16;
}

function ozToGallons(oz: number)   { return oz / 128; }
function gallonsToBBL(gal: number) { return gal / GALLONS_PER_BBL; }
function calcExciseTax(gallons: number) {
  const bbl = gallonsToBBL(gallons);
  return gallons * STATE_EXCISE_PER_GALLON + bbl * FEDERAL_EXCISE_PER_BBL;
}

// ---------------------------------------------------------------------------
// Catalog index
// ---------------------------------------------------------------------------

type DistChannel = "TAPROOM_DRAFT" | "TAPROOM_PACKAGED" | "DISTRIBUTION" | "CONTRACT_BREWING";

interface KegVarInfo  { beerStyle: string; kegSize: string; gallons: number }
interface CanVarInfo  { beerStyle: string; cansPerUnit: number; ozPerUnit: number }

// Packaging Fee keg/can vars: variation ID → size info (beer style comes from line.note)
interface PackagingFeeKegInfo { kegSize: string; gallons: number }
interface PackagingFeeCanInfo { ozPerUnit: number; cansPerUnit: number }

interface CatalogIndex {
  kegVars: Map<string, KegVarInfo>;
  canVars: Map<string, CanVarInfo>;
  contractBrewingVarIds: Set<string>;
  packagingFeeKegVars: Map<string, PackagingFeeKegInfo>;
  packagingFeeCanVars: Map<string, PackagingFeeCanInfo>;
  _draftStyleByNorm: Map<string, string>;
}

function extractBeerStyle(name: string): string {
  return name
    .replace(/ \(Keg\)$/i,  "")
    .replace(/ \(Cans?\)$/i, "")
    .replace(/ Cans?$/i,     "")
    .trim();
}

// Draft item names, normalized for fuzzy matching from Packaging Fee notes
function normalizeBeerName(name: string): string {
  return name.trim().toLowerCase();
}

function buildCatalogIndex(items: CatalogItem[]): CatalogIndex {
  const kegVars               = new Map<string, KegVarInfo>();
  const canVars               = new Map<string, CanVarInfo>();
  const contractBrewingVarIds = new Set<string>();
  const packagingFeeKegVars   = new Map<string, PackagingFeeKegInfo>();
  const packagingFeeCanVars   = new Map<string, PackagingFeeCanInfo>();

  // Build a lookup of normalized draft item names so Packaging Fee notes can be matched
  const draftStyleByNorm = new Map<string, string>();
  for (const item of items) {
    const rc = item.item_data.reporting_category?.id ?? "";
    if (CATEGORY_IDS.DRAFT.has(rc)) {
      const style = item.item_data.name;
      draftStyleByNorm.set(normalizeBeerName(style), style);
    }
  }

  for (const item of items) {
    const rc     = item.item_data.reporting_category?.id ?? "";
    const isKeg  = CATEGORY_IDS.KEGS.has(rc);
    const isCan  = CATEGORY_IDS.CANS.has(rc);
    const isCB   = CATEGORY_IDS.CONTRACT_BREWING.has(rc);

    if (!isKeg && !isCan && !isCB) continue;

    const beerStyle = extractBeerStyle(item.item_data.name);

    for (const v of item.item_data.variations ?? []) {
      const vname = v.item_variation_data.name;

      if (isKeg && KEG_SIZE_PATTERN.test(vname)) {
        kegVars.set(v.id, {
          beerStyle,
          kegSize: vname,
          gallons: KEG_GALLONS[vname] ?? 0,
        });
      }

      if (isCan) {
        const oz         = canOzPerUnit(vname);
        const cansPerUnit = /case/i.test(vname) ? 24
                          : /4-?pack/i.test(vname) ? 4
                          : /6-?pack/i.test(vname) ? 6
                          : /12-?pack/i.test(vname) ? 12
                          : 1;
        canVars.set(v.id, { beerStyle, cansPerUnit, ozPerUnit: oz });
      }

      if (isCB) {
        contractBrewingVarIds.add(v.id);
        // Index Packaging Fee keg/can variants so volume can be attributed via line.note
        if (KEG_SIZE_PATTERN.test(vname) && KEG_GALLONS[vname]) {
          packagingFeeKegVars.set(v.id, { kegSize: vname, gallons: KEG_GALLONS[vname] });
        } else if (/^\d+oz\s+(can|case|4-?pack|6-?pack|12-?pack)/i.test(vname)) {
          const oz = canOzPerUnit(vname);
          const cansPerUnit = /case/i.test(vname) ? 24
                            : /4-?pack/i.test(vname) ? 4
                            : /6-?pack/i.test(vname) ? 6
                            : /12-?pack/i.test(vname) ? 12
                            : 1;
          packagingFeeCanVars.set(v.id, { ozPerUnit: oz, cansPerUnit });
        }
      }
    }
  }

  return { kegVars, canVars, contractBrewingVarIds, packagingFeeKegVars, packagingFeeCanVars, _draftStyleByNorm: draftStyleByNorm };
}

// Exported only for use within this module
function resolveBeerStyleFromNote(note: string | null | undefined, draftStyleByNorm: Map<string, string>): string | null {
  if (!note) return null;
  const norm = normalizeBeerName(note);
  return draftStyleByNorm.get(norm) ?? note.trim();
}

// ---------------------------------------------------------------------------
// Per-style accumulators
// ---------------------------------------------------------------------------

interface StyleAccum {
  taproomDraftGallons:     number;
  taproomPackagedGallons:  number;
  distributionGallons:     number;
  contractGallons:         number;
  halfKegCount:  number;
  quarterKegCount: number;
  sixthKegCount: number;
  totalCans:     number; // individual can equivalents
}

function emptyAccum(): StyleAccum {
  return {
    taproomDraftGallons: 0, taproomPackagedGallons: 0,
    distributionGallons: 0, contractGallons: 0,
    halfKegCount: 0, quarterKegCount: 0, sixthKegCount: 0, totalCans: 0,
  };
}

function addGallons(a: StyleAccum, channel: DistChannel, gallons: number) {
  if (channel === "TAPROOM_DRAFT")     a.taproomDraftGallons     += gallons;
  if (channel === "TAPROOM_PACKAGED")  a.taproomPackagedGallons  += gallons;
  if (channel === "DISTRIBUTION")      a.distributionGallons     += gallons;
  if (channel === "CONTRACT_BREWING")  a.contractGallons         += gallons;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export interface BBLStyleRow {
  style:           string;
  taproomDraftBBL: number;
  taproomPkgBBL:   number;
  distBBL:         number;
  contractBBL:     number;
  halfKegCount:    number;
  quarterKegCount: number;
  sixthKegCount:   number;
  totalCans:       number;
  totalBBL:        number;
  totalGallons:    number;
  exciseTax:       number;
}

export interface BBLChannelRow {
  channel:      string;
  bbl:          number;
  gallons:      number;
}

export interface BBLTrackerResult {
  byStyle:    BBLStyleRow[];
  byChannel:  BBLChannelRow[];
  totalExciseTax: number;
}

export function buildBBLTrackerReport(
  posOrders:     Order[],    // completed POS orders (taproom)
  invoiceOrders: Order[],    // invoice orders (all states)
  items:         CatalogItem[]
): BBLTrackerResult {
  const idx = buildCatalogIndex(items);
  const styles = new Map<string, StyleAccum>();
  const getStyle = (name: string) => {
    if (!styles.has(name)) styles.set(name, emptyAccum());
    return styles.get(name)!;
  };

  // ── POS orders ────────────────────────────────────────────────────────────
  for (const order of posOrders) {
    const discByUid = mapDiscountsByUid(order);

    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id ?? "";
      const qty   = parseInt(line.quantity ?? "1", 10);

      // Keg line item
      const kegInfo = idx.kegVars.get(varId);
      if (kegInfo) {
        const discNames = (line.applied_discounts ?? [])
          .map((ad) => discByUid.get(ad.discount_uid) ?? "");
        const isTransfer = discNames.includes(KEG_TRANSFER_DISCOUNT_NAME);
        const channel: DistChannel = isTransfer ? "TAPROOM_DRAFT" : "TAPROOM_PACKAGED";
        const gallons = kegInfo.gallons * qty;

        const acc = getStyle(kegInfo.beerStyle);
        addGallons(acc, channel, gallons);
        // count kegs (draft transfers count toward half/sixth etc. too)
        if (kegInfo.kegSize === "1/2 Keg") acc.halfKegCount    += qty;
        if (kegInfo.kegSize === "1/4 Keg") acc.quarterKegCount += qty;
        if (kegInfo.kegSize === "1/6 Keg") acc.sixthKegCount   += qty;
        continue;
      }

      // Can line item
      const canInfo = idx.canVars.get(varId);
      if (canInfo) {
        const gallons = ozToGallons(canInfo.ozPerUnit) * qty;
        const acc = getStyle(canInfo.beerStyle);
        addGallons(acc, "TAPROOM_PACKAGED", gallons);
        acc.totalCans += canInfo.cansPerUnit * qty;
      }
    }
  }

  // ── Invoice orders ────────────────────────────────────────────────────────
  for (const order of invoiceOrders) {
    // Determine channel: any CB item on this order → CONTRACT_BREWING, else DISTRIBUTION
    const hasCBItem = (order.line_items ?? []).some(
      (li) => li.catalog_object_id && idx.contractBrewingVarIds.has(li.catalog_object_id)
    );
    const invoiceChannel: DistChannel = hasCBItem ? "CONTRACT_BREWING" : "DISTRIBUTION";

    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id ?? "";
      const qty   = parseInt(line.quantity ?? "1", 10);

      const kegInfo = idx.kegVars.get(varId);
      if (kegInfo) {
        const gallons = kegInfo.gallons * qty;
        const acc = getStyle(kegInfo.beerStyle);
        addGallons(acc, invoiceChannel, gallons);
        if (kegInfo.kegSize === "1/2 Keg") acc.halfKegCount    += qty;
        if (kegInfo.kegSize === "1/4 Keg") acc.quarterKegCount += qty;
        if (kegInfo.kegSize === "1/6 Keg") acc.sixthKegCount   += qty;
        continue;
      }

      const canInfo = idx.canVars.get(varId);
      if (canInfo) {
        const gallons = ozToGallons(canInfo.ozPerUnit) * qty;
        const acc = getStyle(canInfo.beerStyle);
        addGallons(acc, invoiceChannel, gallons);
        acc.totalCans += canInfo.cansPerUnit * qty;
        continue;
      }

      // Packaging Fee keg line — beer style comes from line.note, size from variation_name
      const pfKegInfo = idx.packagingFeeKegVars.get(varId);
      if (pfKegInfo) {
        const beerStyle = resolveBeerStyleFromNote(line.note, idx._draftStyleByNorm);
        if (beerStyle) {
          const gallons = pfKegInfo.gallons * qty;
          const acc = getStyle(beerStyle);
          addGallons(acc, invoiceChannel, gallons);
          if (pfKegInfo.kegSize === "1/2 Keg") acc.halfKegCount    += qty;
          if (pfKegInfo.kegSize === "1/4 Keg") acc.quarterKegCount += qty;
          if (pfKegInfo.kegSize === "1/6 Keg") acc.sixthKegCount   += qty;
        }
        continue;
      }

      // Packaging Fee can line — beer style from line.note
      const pfCanInfo = idx.packagingFeeCanVars.get(varId);
      if (pfCanInfo) {
        const beerStyle = resolveBeerStyleFromNote(line.note, idx._draftStyleByNorm);
        if (beerStyle) {
          const gallons = ozToGallons(pfCanInfo.ozPerUnit) * qty;
          const acc = getStyle(beerStyle);
          addGallons(acc, invoiceChannel, gallons);
          acc.totalCans += pfCanInfo.cansPerUnit * qty;
        }
      }
    }
  }

  // ── Assemble rows ─────────────────────────────────────────────────────────
  const byStyle: BBLStyleRow[] = Array.from(styles.entries())
    .map(([style, a]) => {
      const totalGallons =
        a.taproomDraftGallons + a.taproomPackagedGallons +
        a.distributionGallons + a.contractGallons;
      const totalBBL = gallonsToBBL(totalGallons);
      return {
        style,
        taproomDraftBBL: gallonsToBBL(a.taproomDraftGallons),
        taproomPkgBBL:   gallonsToBBL(a.taproomPackagedGallons),
        distBBL:         gallonsToBBL(a.distributionGallons),
        contractBBL:     gallonsToBBL(a.contractGallons),
        halfKegCount:    a.halfKegCount,
        quarterKegCount: a.quarterKegCount,
        sixthKegCount:   a.sixthKegCount,
        totalCans:       a.totalCans,
        totalBBL,
        totalGallons,
        exciseTax:       calcExciseTax(totalGallons),
      };
    })
    .filter((r) => r.totalBBL > 0)
    .sort((a, b) => b.totalBBL - a.totalBBL);

  // Channel summary
  const chGallons = {
    "Taproom Draft":     Array.from(styles.values()).reduce((s, a) => s + a.taproomDraftGallons, 0),
    "Taproom Packaged":  Array.from(styles.values()).reduce((s, a) => s + a.taproomPackagedGallons, 0),
    "Distribution":      Array.from(styles.values()).reduce((s, a) => s + a.distributionGallons, 0),
    "Contract Brewing":  Array.from(styles.values()).reduce((s, a) => s + a.contractGallons, 0),
  };
  const byChannel: BBLChannelRow[] = Object.entries(chGallons)
    .filter(([, g]) => g > 0)
    .map(([channel, gallons]) => ({ channel, bbl: gallonsToBBL(gallons), gallons }));

  const totalExciseTax = byStyle.reduce((s, r) => s + r.exciseTax, 0);

  return { byStyle, byChannel, totalExciseTax };
}
