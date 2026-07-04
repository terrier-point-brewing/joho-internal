import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOrderSalesByDay, fetchPhysicalCounts, type PhysicalCount } from "./inventory";
import { detectKegSwaps } from "./draftKegEvents";

export type ConsumptionKind = "keg_sale" | "can_sale" | "draft_swap";

export interface ConsumptionUnit {
  recipeId: string;
  variationId: string; // packaging_variations.id to deplete from cold storage
  quantity: number; // TARGET units for this (source); reconciler computes the delta
  sourceRef: string; // "sqsale:<squareVariationId>:<YYYY-MM-DD>" | "sqkegswap:<physicalCountId>"
  kind: ConsumptionKind;
  label: string; // human label for discrepancy/summary display
}

export interface ConfigDiscrepancy {
  kind: "unconfigured_draft_swap";
  recipeId: string;
  beerName: string;
  swapCount: number; // swaps detected but not recordable (no swap config)
}

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
}): { units: ConsumptionUnit[]; discrepancies: ConfigDiscrepancy[] } {
  const { salesByDay, kegCanLinks, draftLinks, physicalCountsByVar, swapByRecipe } = input;

  const units: ConsumptionUnit[] = [];
  const discrepancies: ConfigDiscrepancy[] = [];

  const linkByVarId = new Map<string, KegCanLink>();
  for (const link of kegCanLinks) linkByVarId.set(link.squareVariationId, link);

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

  // Draft keg swaps → one unit per swap when configured, else a discrepancy.
  for (const draft of draftLinks) {
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

/**
 * IO wrapper: loads the Square links + swap config from Supabase, pulls the
 * matching Square sales/physical-counts for the trailing `days` window, then
 * hands everything to the pure `assembleConsumption`.
 */
export async function deriveTaproomConsumption(
  supabase: SupabaseClient,
  opts: { days: number },
): Promise<{ units: ConsumptionUnit[]; discrepancies: ConfigDiscrepancy[] }> {
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

  const kegCanSquareVarIds = kegCanLinks.map((l) => l.squareVariationId);
  const draftSquareVarIds = draftLinks.map((l) => l.squareVariationId);

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

  return assembleConsumption({
    salesByDay,
    kegCanLinks,
    draftLinks,
    physicalCountsByVar,
    swapByRecipe,
  });
}
