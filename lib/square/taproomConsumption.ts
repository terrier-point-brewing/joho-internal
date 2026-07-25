import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchOrderSalesByDay,
  fetchDraftRestockLineItems,
  type RestockLineEvent,
} from "./inventory";
import {
  pairSwapsToRestocks,
  restockEventKey,
  staleSwaps,
  type PendingTapSwap,
} from "@/lib/taproom/tapSwaps";

/** A queued swap unrung for this long is surfaced as a discrepancy, never auto-expired. */
const STALE_SWAP_DAYS = 7;

export type ConsumptionKind = "keg_sale" | "can_sale" | "draft_swap";

/**
 * Trailing reconcile window: from the UTC day boundary `days` back, up to *now*.
 *
 * The end MUST be `now`, not the start of today — Square order search filters on
 * `closed_at`, so a window ending at today-00:00 UTC would miss every order rung
 * today (e.g. a Draft Restock a bartender just fired), which is exactly the case
 * the webhook exists to catch.
 */
export function trailingWindow(now: Date, days: number): { startIso: string; endIso: string } {
  const start = new Date(now.getTime() - days * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: now.toISOString() };
}

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
  /**
   * The queued beer-change transition this restock consumes. Present only when a
   * `tap_swap_transitions` row was paired to this ring — the sync uses it to book
   * the OUTGOING side (write off its residual, zero its Square draft SKU) and to
   * flip `tap_assignments`. Absent for like-for-like restocks.
   */
  swap?: PendingTapSwap;
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

export interface StaleQueuedSwapDiscrepancy {
  kind: "stale_queued_swap";
  tapNumber: number;
  swapId: string;
  openedAt: string;
  toBeerName: string;
}

export type AssemblyDiscrepancy =
  | ConfigDiscrepancy
  | UnmappedRestockDiscrepancy
  | StaleQueuedSwapDiscrepancy;

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
  pendingSwaps?: PendingTapSwap[]; // queued beer-change transitions awaiting a ring
  nowIso?: string; // enables staleness reporting; omitted keeps this fully time-free
}): { units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] } {
  const {
    salesByDay,
    kegCanLinks,
    draftLinks,
    restockEvents = [],
    tapRestockLinks = [],
    pendingSwaps = [],
    nowIso,
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

  // Pair queued beer-change transitions to rings, FIFO per tap. A paired ring
  // resolves entirely off the FROZEN transition; an unpaired one keeps resolving
  // off the (mutable) tap row, which is correct for a like-for-like restock.
  const tapByRestockVar = new Map<string, number>();
  for (const link of tapRestockLinks) tapByRestockVar.set(link.restockVariationId, link.tapNumber);
  const pairedSwaps = pairSwapsToRestocks(restockEvents, tapByRestockVar, pendingSwaps);

  const restockUnconfigured = new Map<string, { beerName: string; count: number }>();
  const unmappedRestock = new Map<string, number>();
  for (const ev of restockEvents) {
    const link = linkByRestockVar.get(ev.squareVariationId);
    if (!link || !link.recipeId) {
      unmappedRestock.set(ev.squareVariationId, (unmappedRestock.get(ev.squareVariationId) ?? 0) + 1);
      continue;
    }
    const swap = pairedSwaps.get(restockEventKey(ev.orderId, ev.lineUid));

    // Resolved swap target: the transition when one is paired, else the tap row.
    const recipeId = swap ? swap.toRecipeId : link.recipeId;
    const beerName = swap ? swap.toBeerName : link.beerName;
    const variationId = swap ? swap.toVariationId : link.swapVariationId;
    const volumeFlOz = swap ? swap.toVolumeFlOz : link.swapVolumeFlOz;

    if (!variationId || !volumeFlOz) {
      const prev = restockUnconfigured.get(recipeId);
      restockUnconfigured.set(recipeId, { beerName, count: (prev?.count ?? 0) + 1 });
      continue;
    }
    const draftSquareVar = swap ? swap.toDraftSquareVariationId : draftSquareVarByRecipe.get(recipeId);
    units.push({
      recipeId,
      variationId,
      quantity: ev.quantity,
      sourceRef: `sqtransfer:${ev.orderId}:${ev.lineUid}`,
      kind: "draft_swap",
      label: `${beerName} · Tap ${link.tapNumber} restock · ${ev.occurredAt.slice(0, 10)}`,
      tapNumber: link.tapNumber,
      recount: draftSquareVar
        ? { squareVariationId: draftSquareVar, quantity: volumeFlOz, occurredAt: ev.occurredAt }
        : undefined,
      swap,
    });
  }
  for (const [recipeId, v] of restockUnconfigured) {
    discrepancies.push({ kind: "unconfigured_draft_swap", recipeId, beerName: v.beerName, swapCount: v.count });
  }
  for (const [squareVariationId, count] of unmappedRestock) {
    discrepancies.push({ kind: "unmapped_restock", squareVariationId, count });
  }

  // A swap queued but never rung would otherwise sit silently and attach to a much
  // later ring. Only reported when the caller supplies a clock.
  if (nowIso) {
    for (const s of staleSwaps(pendingSwaps, pairedSwaps, nowIso, STALE_SWAP_DAYS)) {
      discrepancies.push({
        kind: "stale_queued_swap",
        tapNumber: s.tapNumber,
        swapId: s.id,
        openedAt: s.openedAt,
        toBeerName: s.toBeerName,
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

/** Raw `tap_swap_transitions` row as selected below (numerics arrive as strings). */
interface TapSwapTransitionRow {
  id: string;
  tap_number: number;
  from_recipe_id: string | null;
  from_variation_id: string | null;
  from_volume_fl_oz: number | string | null;
  from_draft_square_variation_id: string | null;
  to_recipe_id: string;
  to_variation_id: string;
  to_volume_fl_oz: number | string;
  to_draft_square_variation_id: string | null;
  opened_at: string;
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
  const { startIso: startDate, endIso: endDate } = trailingWindow(new Date(), opts.days);

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

  // Pending beer-change transitions. NO PostgREST embed: this table has two FKs to
  // `recipes` (from_recipe_id / to_recipe_id), and constraint-name-disambiguated
  // embeds have crashed this codebase with PGRST200 because prod FK names are
  // non-canonical. Beer names are resolved with a second plain query instead.
  const { data: swapRows, error: swapErr } = await supabase
    .from("tap_swap_transitions")
    .select(
      "id, tap_number, from_recipe_id, from_variation_id, from_volume_fl_oz, from_draft_square_variation_id, to_recipe_id, to_variation_id, to_volume_fl_oz, to_draft_square_variation_id, opened_at",
    )
    .is("consumed_source_ref", null)
    .order("opened_at");
  if (swapErr) throw new Error(swapErr.message);

  const swapTransitionRows = (swapRows ?? []) as unknown as TapSwapTransitionRow[];
  const swapRecipeIds = [
    ...new Set(
      swapTransitionRows.flatMap((r) => [r.from_recipe_id, r.to_recipe_id]).filter((id): id is string => !!id),
    ),
  ];
  const beerNameById = new Map<string, string>();
  if (swapRecipeIds.length > 0) {
    const { data: recipeRows, error: recipeErr } = await supabase
      .from("recipes")
      .select("id, beer_name")
      .in("id", swapRecipeIds);
    if (recipeErr) throw new Error(recipeErr.message);
    for (const r of (recipeRows ?? []) as { id: string; beer_name: string | null }[]) {
      beerNameById.set(r.id, r.beer_name ?? "");
    }
  }

  const pendingSwaps: PendingTapSwap[] = swapTransitionRows.map((r) => ({
    id: r.id,
    tapNumber: r.tap_number,
    fromRecipeId: r.from_recipe_id,
    fromBeerName: r.from_recipe_id ? beerNameById.get(r.from_recipe_id) ?? "" : null,
    fromVariationId: r.from_variation_id,
    fromVolumeFlOz: r.from_volume_fl_oz != null ? Number(r.from_volume_fl_oz) : null,
    fromDraftSquareVariationId: r.from_draft_square_variation_id,
    toRecipeId: r.to_recipe_id,
    toBeerName: beerNameById.get(r.to_recipe_id) ?? "",
    toVariationId: r.to_variation_id,
    toVolumeFlOz: Number(r.to_volume_fl_oz),
    toDraftSquareVariationId: r.to_draft_square_variation_id,
    openedAt: r.opened_at,
  }));

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
    pendingSwaps,
    nowIso: new Date().toISOString(),
  });
}
