import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOrderSalesByDay,
  fetchPhysicalCounts,
  fetchDraftRestockLineItems,
  type PhysicalCount,
  type RestockLineEvent,
} from "./inventory";
import { detectKegSwaps } from "./draftKegEvents";

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

// tap → its Square "Draft Restock" variation, with the recipe currently on the tap
export interface TapRestockLink {
  restockVariationId: string;
  tapNumber: number;
  recipeId: string | null;
  beerName: string;
}

// per-recipe swap config from taproom_recipe_settings
export interface SwapConfig {
  swapVariationId: string | null;
  swapVolumeFlOz: number | null;
}

// Default full-keg retop level (fl oz) for swap detection when a recipe has no
// explicit swap_volume_fl_oz — a 1/6 barrel keg.
const DEFAULT_SWAP_VOLUME_FL_OZ = 660;

/**
 * PURE assembler: turns Square taproom activity + config into target
 * consumption units (for a later reconciler to record) plus draft-config
 * discrepancies. No IO — every input is passed in.
 */
export function assembleConsumption(input: {
  salesByDay: Map<string, number>; // "<squareVariationId>\t<YYYY-MM-DD>" -> units
  kegCanLinks: KegCanLink[];
  draftLinks: DraftLink[];
  physicalCountsByVar: Map<string, PhysicalCount[]>; // squareVariationId -> counts
  swapByRecipe: Map<string, SwapConfig>;
  restockEvents?: RestockLineEvent[]; // bartender-recorded keg swaps (the new path)
  tapRestockLinks?: TapRestockLink[]; // restock variation → tap → recipe
}): { units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] } {
  const {
    salesByDay,
    kegCanLinks,
    draftLinks,
    physicalCountsByVar,
    swapByRecipe,
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
  // units. This is the preferred path: a rung line item is an unambiguous signal,
  // and each unit carries a recount that resets the draft SKU to full.
  const linkByRestockVar = new Map<string, TapRestockLink>();
  const restockRecipeIds = new Set<string>(); // recipes handled here (skip crossing-inference)
  for (const link of tapRestockLinks) {
    linkByRestockVar.set(link.restockVariationId, link);
    if (link.recipeId) restockRecipeIds.add(link.recipeId);
  }

  const restockUnconfigured = new Map<string, { beerName: string; count: number }>();
  const unmappedRestock = new Map<string, number>();
  for (const ev of restockEvents) {
    const link = linkByRestockVar.get(ev.squareVariationId);
    if (!link || !link.recipeId) {
      // A restock line rung for a variation not mapped to a tap+recipe.
      unmappedRestock.set(ev.squareVariationId, (unmappedRestock.get(ev.squareVariationId) ?? 0) + 1);
      continue;
    }
    const cfg = swapByRecipe.get(link.recipeId);
    if (!cfg?.swapVariationId || !cfg?.swapVolumeFlOz) {
      const prev = restockUnconfigured.get(link.recipeId);
      restockUnconfigured.set(link.recipeId, { beerName: link.beerName, count: (prev?.count ?? 0) + 1 });
      continue;
    }
    const draftSquareVar = draftSquareVarByRecipe.get(link.recipeId);
    units.push({
      recipeId: link.recipeId,
      variationId: cfg.swapVariationId,
      quantity: ev.quantity,
      sourceRef: `sqtransfer:${ev.orderId}:${ev.lineUid}`,
      kind: "draft_swap",
      label: `${link.beerName} · Tap ${link.tapNumber} restock · ${ev.occurredAt.slice(0, 10)}`,
      recount: draftSquareVar
        ? { squareVariationId: draftSquareVar, quantity: cfg.swapVolumeFlOz, occurredAt: ev.occurredAt }
        : undefined,
    });
  }
  for (const [recipeId, v] of restockUnconfigured) {
    discrepancies.push({ kind: "unconfigured_draft_swap", recipeId, beerName: v.beerName, swapCount: v.count });
  }
  for (const [squareVariationId, count] of unmappedRestock) {
    discrepancies.push({ kind: "unmapped_restock", squareVariationId, count });
  }

  // Draft keg swaps → one unit per swap when configured, else a discrepancy.
  // Recipes with a restock mapping are handled above (deterministically) — skip
  // them here so a restock-triggered recount to full isn't double-counted as an
  // inferred crossing.
  for (const draft of draftLinks) {
    if (restockRecipeIds.has(draft.recipeId)) continue;
    const counts = physicalCountsByVar.get(draft.squareVariationId) ?? [];
    const cfg = swapByRecipe.get(draft.recipeId);
    const complete = Boolean(cfg?.swapVariationId && cfg?.swapVolumeFlOz);
    const swaps = detectKegSwaps(counts, cfg?.swapVolumeFlOz ?? DEFAULT_SWAP_VOLUME_FL_OZ);

    if (swaps.length === 0) continue;

    if (!complete) {
      discrepancies.push({
        kind: "unconfigured_draft_swap",
        recipeId: draft.recipeId,
        beerName: draft.beerName,
        swapCount: swaps.length,
      });
      continue;
    }

    for (const swap of swaps) {
      units.push({
        recipeId: draft.recipeId,
        variationId: cfg!.swapVariationId!,
        quantity: 1,
        sourceRef: `sqkegswap:${swap.physicalCountId}`,
        kind: "draft_swap",
        label: `${draft.beerName} · keg swap · ${swap.date}`,
      });
    }
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

interface TaproomRecipeSettingsRow {
  recipe_id: string;
  swap_variation_id: string | null;
  swap_volume_fl_oz: number | null;
}

interface TapAssignmentRow {
  tap_number: number;
  recipe_id: string | null;
  restock_variation_id: string | null;
  recipes: { beer_name: string } | null;
}

/**
 * IO wrapper: loads the Square links + swap config from Supabase, pulls the
 * matching Square sales/physical-counts for the trailing `days` window, then
 * hands everything to the pure `assembleConsumption`.
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

  const { data: settingsRows, error: settingsErr } = await supabase
    .from("taproom_recipe_settings")
    .select("recipe_id, swap_variation_id, swap_volume_fl_oz");
  if (settingsErr) throw new Error(settingsErr.message);

  const swapByRecipe = new Map<string, SwapConfig>();
  for (const s of (settingsRows ?? []) as TaproomRecipeSettingsRow[]) {
    swapByRecipe.set(s.recipe_id, {
      swapVariationId: s.swap_variation_id,
      swapVolumeFlOz: s.swap_volume_fl_oz,
    });
  }

  // Tap → restock variation mapping (only taps that have a restock line configured).
  const { data: tapRows, error: tapErr } = await supabase
    .from("tap_assignments")
    .select("tap_number, recipe_id, restock_variation_id, recipes(beer_name)");
  if (tapErr) throw new Error(tapErr.message);

  const tapRestockLinks: TapRestockLink[] = [];
  for (const t of (tapRows ?? []) as unknown as TapAssignmentRow[]) {
    if (!t.restock_variation_id) continue;
    tapRestockLinks.push({
      restockVariationId: t.restock_variation_id,
      tapNumber: t.tap_number,
      recipeId: t.recipe_id,
      beerName: t.recipes?.beer_name ?? "",
    });
  }

  const kegCanSquareVarIds = kegCanLinks.map((l) => l.squareVariationId);
  const draftSquareVarIds = draftLinks.map((l) => l.squareVariationId);
  const restockSquareVarIds = tapRestockLinks.map((l) => l.restockVariationId);

  const salesByDay =
    kegCanSquareVarIds.length > 0
      ? await fetchOrderSalesByDay(startDate, endDate, kegCanSquareVarIds)
      : new Map<string, number>();

  const physicalCountsByVar = new Map<string, PhysicalCount[]>();
  if (draftSquareVarIds.length > 0) {
    const counts = await fetchPhysicalCounts(startDate, endDate, draftSquareVarIds);
    for (const c of counts) {
      const list = physicalCountsByVar.get(c.catalog_object_id) ?? [];
      list.push(c);
      physicalCountsByVar.set(c.catalog_object_id, list);
    }
  }

  const restockEvents =
    restockSquareVarIds.length > 0
      ? await fetchDraftRestockLineItems(startDate, endDate, restockSquareVarIds)
      : [];

  return assembleConsumption({
    salesByDay,
    kegCanLinks,
    draftLinks,
    physicalCountsByVar,
    swapByRecipe,
    restockEvents,
    tapRestockLinks,
  });
}
