import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOrderSalesByDay,
  fetchDraftRestockLineItems,
  type RestockLineEvent,
} from "./inventory";

export type ConsumptionKind = "keg_sale" | "can_sale" | "draft_swap";

/** Square recount to apply after a unit is first recorded (draft keg swaps only). */
export interface RecountInstruction {
  squareVariationId: string; // the draft SKU to reset
  quantity: number; // absolute fl oz to set it to (full-keg volume)
  occurredAt: string; // RFC3339 timestamp of the triggering restock order
}

export interface ConsumptionUnit {
  recipeId: string;
  variationId: string; // packaging_variations.id to deplete from cold storage
  quantity: number; // TARGET units for this (source); reconciler computes the delta
  sourceRef: string; // "sqsale:<sqVarId>:<day>" | "sqkegswap:<physicalCountId>" | "sqtransfer:<orderId>:<lineUid>"
  kind: ConsumptionKind;
  label: string; // human label for discrepancy/summary display
  tapNumber?: number; // the tap this swap drained (restock-driven draft swaps only)
  recount?: RecountInstruction; // set for restock-driven draft swaps; drives the Square recount
}

export interface ConfigDiscrepancy {
  kind: "unconfigured_draft_swap";
  recipeId: string;
  beerName: string;
  swapCount: number; // swaps detected but not recordable (no swap config)
}

export interface UnmappedRestockDiscrepancy {
  kind: "unmapped_restock";
  squareVariationId: string; // a restock line item whose variation isn't mapped to a tap+recipe
  count: number;
}

export type AssemblyDiscrepancy = ConfigDiscrepancy | UnmappedRestockDiscrepancy;

// keg/can Square SKU -> cold-storage variation
export interface KegCanLink {
  squareVariationId: string;
  recipeId: string;
  variationId: string;
  kind: "keg_sale" | "can_sale";
  beerName: string;
  variationName: string;
}

// draft link (recipe-grain)
export interface DraftLink {
  squareVariationId: string;
  recipeId: string;
  beerName: string;
}

// tap → its Square "Draft Restock" variation, plus the tap's own swap config
export interface TapRestockLink {
  restockVariationId: string;
  tapNumber: number;
  recipeId: string | null;
  beerName: string;
  swapVariationId: string | null;   // cold-storage packaging variation to drain
  swapVolumeFlOz: number | null;    // full-keg recount target
}

/**
 * PURE assembler: turns Square taproom activity + config into target
 * consumption units (for a later reconciler to record) plus draft-config
 * discrepancies. No IO — every input is passed in.
 */
export function assembleConsumption(input: {
  salesByDay: Map<string, number>; // "<squareVariationId>\t<YYYY-MM-DD>" -> units
  kegCanLinks: KegCanLink[];
  draftLinks: DraftLink[];
  restockEvents?: RestockLineEvent[]; // bartender-recorded keg swaps (the new path)
  tapRestockLinks?: TapRestockLink[]; // restock variation → tap → recipe + swap config
}): { units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] } {
  const {
    salesByDay,
    kegCanLinks,
    draftLinks,
    restockEvents = [],
    tapRestockLinks = [],
  } = input;

  const units: ConsumptionUnit[] = [];
  const discrepancies: AssemblyDiscrepancy[] = [];

  const linkByVarId = new Map<string, KegCanLink>();
  for (const link of kegCanLinks) linkByVarId.set(link.squareVariationId, link);

  // Recipe → its draft SKU (the variation the recount resets to full).
  const draftSquareVarByRecipe = new Map<string, string>();
  for (const d of draftLinks) draftSquareVarByRecipe.set(d.recipeId, d.squareVariationId);

  // Keg/can sales → one unit per (variation, day).
  for (const [key, qty] of salesByDay) {
    if (qty <= 0) continue;
    const [sqVarId, day] = key.split("\t");
    const link = linkByVarId.get(sqVarId);
    if (!link) continue; // sale for an unmapped SKU — can't resolve a cold-storage variation
    units.push({
      recipeId: link.recipeId,
      variationId: link.variationId,
      quantity: qty,
      sourceRef: `sqsale:${sqVarId}:${day}`,
      kind: link.kind,
      label: `${link.beerName} · ${link.variationName} · ${day}`,
    });
  }

  // Restock line items (bartender-recorded keg swaps) → deterministic draft_swap
  // units. This is the ONLY draft-swap path: a rung line item is an unambiguous
  // signal, its swap keg + recount target come from the tap, and each unit carries
  // a recount that resets the draft SKU to full.
  const linkByRestockVar = new Map<string, TapRestockLink>();
  for (const link of tapRestockLinks) linkByRestockVar.set(link.restockVariationId, link);

  const restockUnconfigured = new Map<string, { beerName: string; count: number }>();
  const unmappedRestock = new Map<string, number>();
  for (const ev of restockEvents) {
    const link = linkByRestockVar.get(ev.squareVariationId);
    if (!link || !link.recipeId) {
      unmappedRestock.set(ev.squareVariationId, (unmappedRestock.get(ev.squareVariationId) ?? 0) + 1);
      continue;
    }
    if (!link.swapVariationId || !link.swapVolumeFlOz) {
      const prev = restockUnconfigured.get(link.recipeId);
      restockUnconfigured.set(link.recipeId, { beerName: link.beerName, count: (prev?.count ?? 0) + 1 });
      continue;
    }
    const draftSquareVar = draftSquareVarByRecipe.get(link.recipeId);
    units.push({
      recipeId: link.recipeId,
      variationId: link.swapVariationId,
      quantity: ev.quantity,
      sourceRef: `sqtransfer:${ev.orderId}:${ev.lineUid}`,
      kind: "draft_swap",
      label: `${link.beerName} · Tap ${link.tapNumber} restock · ${ev.occurredAt.slice(0, 10)}`,
      tapNumber: link.tapNumber,
      recount: draftSquareVar
        ? { squareVariationId: draftSquareVar, quantity: link.swapVolumeFlOz, occurredAt: ev.occurredAt }
        : undefined,
    });
  }
  for (const [recipeId, v] of restockUnconfigured) {
    discrepancies.push({ kind: "unconfigured_draft_swap", recipeId, beerName: v.beerName, swapCount: v.count });
  }
  for (const [squareVariationId, count] of unmappedRestock) {
    discrepancies.push({ kind: "unmapped_restock", squareVariationId, count });
  }

  return { units, discrepancies };
}

interface RecipeSquareLinkRow {
  recipe_id: string;
  packaging: string;
  square_variation_id: string;
  variation_id: string | null;
  variation_name: string | null;
  item_name: string | null;
  recipes: { beer_name: string } | null;
}

interface TapAssignmentRow {
  tap_number: number;
  recipe_id: string | null;
  restock_variation_id: string | null;
  swap_variation_id: string | null;
  swap_volume_fl_oz: number | null;
  recipes: { beer_name: string } | null;
}

/**
 * IO wrapper: loads the Square links + per-tap swap config from Supabase, pulls
 * the matching Square sales + restock line items for the trailing `days` window,
 * then hands everything to the pure `assembleConsumption`.
 */
export async function deriveTaproomConsumption(
  supabase: SupabaseClient,
  opts: { days: number },
): Promise<{ units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] }> {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const startDate = new Date(now.getTime() - opts.days * 86400000).toISOString().slice(0, 10);

  const { data: linkRows, error: linkErr } = await supabase
    .from("recipe_square_links")
    .select(
      "recipe_id, packaging, square_variation_id, variation_id, variation_name, item_name, recipes(beer_name)",
    );
  if (linkErr) throw new Error(linkErr.message);

  const rows = (linkRows ?? []) as unknown as RecipeSquareLinkRow[];

  const kegCanLinks: KegCanLink[] = [];
  const draftLinks: DraftLink[] = [];
  for (const row of rows) {
    const beerName = row.recipes?.beer_name ?? row.item_name ?? "";
    if (row.packaging === "draft") {
      draftLinks.push({
        squareVariationId: row.square_variation_id,
        recipeId: row.recipe_id,
        beerName,
      });
    } else if (row.packaging === "keg" || row.packaging === "can") {
      // Skip unmapped keg/can rows — without variation_id they can't resolve to
      // a cold-storage variation.
      if (!row.variation_id) continue;
      kegCanLinks.push({
        squareVariationId: row.square_variation_id,
        recipeId: row.recipe_id,
        variationId: row.variation_id,
        kind: row.packaging === "keg" ? "keg_sale" : "can_sale",
        beerName,
        variationName: row.variation_name ?? "",
      });
    }
  }

  // Tap → restock variation mapping + the tap's own swap config (only taps that
  // have a restock line configured).
  const { data: tapRows, error: tapErr } = await supabase
    .from("tap_assignments")
    .select("tap_number, recipe_id, restock_variation_id, swap_variation_id, swap_volume_fl_oz, recipes(beer_name)");
  if (tapErr) throw new Error(tapErr.message);

  const tapRestockLinks: TapRestockLink[] = [];
  for (const t of (tapRows ?? []) as unknown as TapAssignmentRow[]) {
    if (!t.restock_variation_id) continue;
    tapRestockLinks.push({
      restockVariationId: t.restock_variation_id,
      tapNumber: t.tap_number,
      recipeId: t.recipe_id,
      beerName: t.recipes?.beer_name ?? "",
      swapVariationId: t.swap_variation_id,
      swapVolumeFlOz: t.swap_volume_fl_oz,
    });
  }

  const kegCanSquareVarIds = kegCanLinks.map((l) => l.squareVariationId);
  const restockSquareVarIds = tapRestockLinks.map((l) => l.restockVariationId);

  const salesByDay =
    kegCanSquareVarIds.length > 0
      ? await fetchOrderSalesByDay(startDate, endDate, kegCanSquareVarIds)
      : new Map<string, number>();

  const restockEvents =
    restockSquareVarIds.length > 0
      ? await fetchDraftRestockLineItems(startDate, endDate, restockSquareVarIds)
      : [];

  return assembleConsumption({
    salesByDay,
    kegCanLinks,
    draftLinks,
    restockEvents,
    tapRestockLinks,
  });
}
