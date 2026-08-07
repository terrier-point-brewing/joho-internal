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
import { findDeadLinks } from "./linkHealth";

/** A queued swap unrung for this long is surfaced as a discrepancy, never auto-expired. */
const STALE_SWAP_DAYS = 7;

export type ConsumptionKind = "keg_sale" | "can_sale" | "draft_swap";

/** The span of Square activity a single reconcile pass actually looked at. */
export interface ConsumptionWindow {
  startIso: string;
  endIso: string;
  days: number;
}

/**
 * Trailing reconcile window: from the UTC day boundary `days` back, up to *now*.
 *
 * The end MUST be `now`, not the start of today — Square order search filters on
 * `closed_at`, so a window ending at today-00:00 UTC would miss every order rung
 * today (e.g. a Draft Restock a bartender just fired), which is exactly the case
 * the webhook exists to catch.
 */
export function trailingWindow(now: Date, days: number): ConsumptionWindow {
  const start = new Date(now.getTime() - days * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: now.toISOString(), days };
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
  /**
   * RFC3339 timestamp of the triggering restock order. Set for draft swaps —
   * needed for the outgoing keg's shrinkage row even when the incoming recipe has
   * no draft Square link (so there is no `recount` to read it from).
   */
  occurredAt?: string;
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

/**
 * Beer sold in the taproom that had nowhere to be booked.
 *
 * Narrowed to variations whose Square ITEM is already mapped for some other
 * variation — a sale on a sibling of a mapped SKU is a mapping gap, whereas a
 * burger has no mapped siblings and is not interesting. That narrowing is what
 * makes this reportable instead of noise.
 *
 * This is not hypothetical: when Epic Hazy's "Regular" variations were deleted
 * and recreated in Square, the links still pointed at the dead ids, so 23
 * four-packs and a single can sold against the live ids and drained nothing.
 * Roughly 93 cans that cold storage still believes are on the shelf.
 */
export interface UnmappedSaleDiscrepancy {
  kind: "unmapped_sale";
  squareVariationId: string;
  /** Total units sold across the window with no link to book them against. */
  quantity: number;
  days: string[];
}

/**
 * A keg/can link with no cold-storage variation behind it. Its Square sales can
 * never deplete anything, so it is a half-finished mapping rather than a working
 * one.
 */
export interface LinkMissingVariationDiscrepancy {
  kind: "link_missing_cold_storage_variation";
  recipeId: string;
  squareVariationId: string;
  beerName: string;
  variationName: string;
}

/**
 * A mapping pointed at a Square variation that no longer exists.
 *
 * The most damaging shape of miss this sync has, because it is invisible from
 * the inside: sales are fetched by the ids the links hold, so a dead id simply
 * stops matching anything and the run looks like a quiet night. That is how nine
 * days of Epic Hazy can sales drained nothing and reported nothing.
 *
 * Detection lives in `findDeadLinks` and is cheap — one read of the catalog
 * mirror, no Square round trip — so it runs on every reconcile rather than only
 * when somebody opens the Taproom drift panel.
 */
export interface DeadLinkDiscrepancy {
  kind: "dead_square_link";
  recipeId: string;
  squareVariationId: string;
  packaging: string;
  itemName: string | null;
  variationName: string | null;
  reason: "deleted_in_square" | "missing_from_catalog";
}

export type AssemblyDiscrepancy =
  | ConfigDiscrepancy
  | UnmappedRestockDiscrepancy
  | StaleQueuedSwapDiscrepancy
  | UnmappedSaleDiscrepancy
  | LinkMissingVariationDiscrepancy
  | DeadLinkDiscrepancy;

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
  swapVolumeFlOz: number | null;    // full-keg recount target — that variation's coded volume
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
  /**
   * Variations that SHOULD have a keg/can link but don't — siblings on an item
   * that is otherwise mapped. A sale landing on one of these is reported rather
   * than silently dropped. Omit to keep the old silent behaviour.
   */
  unmappedSaleCandidates?: ReadonlySet<string>;
  nowIso?: string; // enables staleness reporting; omitted keeps this fully time-free
}): { units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] } {
  const {
    salesByDay,
    kegCanLinks,
    draftLinks,
    restockEvents = [],
    tapRestockLinks = [],
    pendingSwaps = [],
    unmappedSaleCandidates,
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
  const unmappedSales = new Map<string, { quantity: number; days: Set<string> }>();
  for (const [key, qty] of salesByDay) {
    if (qty <= 0) continue;
    const [sqVarId, day] = key.split("\t");
    const link = linkByVarId.get(sqVarId);
    if (!link) {
      // A sale with no link books nothing. Reported when the variation looks like
      // it should have been mapped, so the beer that left is visible instead of
      // being dropped on the floor — the failure mode that hid ~93 cans of Epic
      // Hazy behind a stale link for nine days.
      if (unmappedSaleCandidates?.has(sqVarId)) {
        const acc = unmappedSales.get(sqVarId) ?? { quantity: 0, days: new Set<string>() };
        acc.quantity += qty;
        acc.days.add(day);
        unmappedSales.set(sqVarId, acc);
      }
      continue;
    }
    units.push({
      recipeId: link.recipeId,
      variationId: link.variationId,
      quantity: qty,
      sourceRef: `sqsale:${sqVarId}:${day}`,
      kind: link.kind,
      label: `${link.beerName} · ${link.variationName} · ${day}`,
    });
  }

  for (const [squareVariationId, acc] of unmappedSales) {
    discrepancies.push({
      kind: "unmapped_sale",
      squareVariationId,
      quantity: acc.quantity,
      days: [...acc.days].sort(),
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
      occurredAt: ev.occurredAt,
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
  square_item_id: string | null;
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
  recipes: { beer_name: string } | null;
  // The swap keg's own coded volume — the recount target, joined not stored.
  packaging_variations: { total_volume_fl_oz: number | null } | null;
}

/**
 * IO wrapper: loads the Square links + per-tap swap config from Supabase, pulls
 * the matching Square sales + restock line items for the trailing `days` window,
 * then hands everything to the pure `assembleConsumption`.
 */
export async function deriveTaproomConsumption(
  supabase: SupabaseClient,
  opts: { days: number; window?: ConsumptionWindow },
): Promise<{ units: ConsumptionUnit[]; discrepancies: AssemblyDiscrepancy[] }> {
  // The caller may hand down the window it intends to report, so the span named
  // in a run summary is provably the span that was queried rather than a second
  // computation of "now" that could drift from it.
  const { startIso: startDate, endIso: endDate } = opts.window ?? trailingWindow(new Date(), opts.days);

  const { data: linkRows, error: linkErr } = await supabase
    .from("recipe_square_links")
    .select(
      "recipe_id, packaging, square_variation_id, square_item_id, variation_id, variation_name, item_name, recipes(beer_name)",
    );
  if (linkErr) throw new Error(linkErr.message);

  const rows = (linkRows ?? []) as unknown as RecipeSquareLinkRow[];

  const kegCanLinks: KegCanLink[] = [];
  const draftLinks: DraftLink[] = [];
  const halfMappedLinks: LinkMissingVariationDiscrepancy[] = [];
  for (const row of rows) {
    const beerName = row.recipes?.beer_name ?? row.item_name ?? "";
    if (row.packaging === "draft") {
      draftLinks.push({
        squareVariationId: row.square_variation_id,
        recipeId: row.recipe_id,
        beerName,
      });
    } else if (row.packaging === "keg" || row.packaging === "can") {
      // Without a cold-storage variation the link can't deplete anything, so its
      // sales would vanish. Reported rather than skipped in silence.
      if (!row.variation_id) {
        halfMappedLinks.push({
          kind: "link_missing_cold_storage_variation",
          recipeId: row.recipe_id,
          squareVariationId: row.square_variation_id,
          beerName,
          variationName: row.variation_name ?? "",
        });
        continue;
      }
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
    // Plain embed for the swap keg's volume — one FK into packaging_variations,
    // so unlike the tap_swap_transitions read below there is nothing to
    // disambiguate and no constraint name to depend on.
    .select("tap_number, recipe_id, restock_variation_id, swap_variation_id, recipes(beer_name), packaging_variations(total_volume_fl_oz)");
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
      swapVolumeFlOz: t.packaging_variations?.total_volume_fl_oz ?? null,
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

  // Variations that ought to be mapped but aren't: live siblings on an item that
  // already carries a keg/can link. Narrowing to mapped items keeps food, merch
  // and cocktails out of it — an unmapped burger is not a mapping gap, an
  // unmapped variation of a beer we already sell is.
  //
  // Sales are then fetched for these too, so a sale landing on one is reported
  // instead of being filtered out before assembly ever sees it. That pre-filter
  // is precisely why the recreated Epic Hazy SKUs drained nothing and said
  // nothing: the sale carried the live id, and only the dead one was requested.
  const mappedItemIds = new Set(
    rows.filter((r) => r.packaging === "keg" || r.packaging === "can")
      .map((r) => r.square_item_id)
      .filter((id): id is string => !!id),
  );
  const linkedVarIds = new Set(rows.map((r) => r.square_variation_id));

  const unmappedSaleCandidates = new Set<string>();
  if (mappedItemIds.size > 0) {
    const { data: siblingRows, error: siblingErr } = await supabase
      .from("square_catalog_variations")
      .select("square_variation_id, square_item_id")
      .in("square_item_id", [...mappedItemIds])
      .eq("is_deleted", false);
    if (siblingErr) throw new Error(siblingErr.message);
    for (const v of (siblingRows ?? []) as { square_variation_id: string }[]) {
      if (!linkedVarIds.has(v.square_variation_id)) unmappedSaleCandidates.add(v.square_variation_id);
    }
  }

  const saleVarIds = [...new Set([...kegCanSquareVarIds, ...unmappedSaleCandidates])];
  const salesByDay =
    saleVarIds.length > 0
      ? await fetchOrderSalesByDay(startDate, endDate, saleVarIds)
      : new Map<string, number>();

  const restockEvents =
    restockSquareVarIds.length > 0
      ? await fetchDraftRestockLineItems(startDate, endDate, restockSquareVarIds)
      : [];

  const assembled = assembleConsumption({
    salesByDay,
    kegCanLinks,
    draftLinks,
    restockEvents,
    tapRestockLinks,
    pendingSwaps,
    unmappedSaleCandidates,
    nowIso: new Date().toISOString(),
  });

  // A mapping pointing at a variation Square no longer has cannot be found by
  // assembling sales — its sales never arrive to be assembled. It is read off the
  // catalog mirror instead, and reported here so a broken mapping raises itself
  // on the nightly run rather than waiting for someone to open the drift panel.
  // Best-effort: this is a report about the run, and losing it must never cost
  // the reconciliation the run just did.
  let deadLinks: DeadLinkDiscrepancy[] = [];
  try {
    deadLinks = (await findDeadLinks(supabase)).map((d) => ({
      kind: "dead_square_link" as const,
      recipeId: d.recipeId,
      squareVariationId: d.squareVariationId,
      packaging: d.packaging,
      itemName: d.itemName,
      variationName: d.variationName,
      reason: d.reason,
    }));
  } catch (e) {
    console.error("[taproom-sync] dead-link check failed", e instanceof Error ? e.message : String(e));
  }

  // Half-finished mappings are found while loading links, not while assembling,
  // so they join the assembler's own findings here.
  return {
    ...assembled,
    discrepancies: [...assembled.discrepancies, ...halfMappedLinks, ...deadLinks],
  };
}
