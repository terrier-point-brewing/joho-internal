import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { aggregateShrinkage, type SwapShrinkageRow } from "@/lib/reports/draftShrinkage";
import { swapReserveFlOz, tapBblOnHand } from "@/lib/reports/draftTapMetrics";
import { apiError } from "@/lib/utils/api";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

/** A queued beer change on a tap, awaiting its Draft Restock ring. */
interface QueuedSwap {
  id: string;
  to_recipe_id: string;
  to_beer_name: string;
  to_variation_name: string;
  opened_at: string;
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const days = Math.min(parseInt(new URL(req.url).searchParams.get("days") ?? "90"), 365);

    // Fetch tap config, sell-through data (draft only), swap-keg cold storage, and
    // retired settings in parallel. Shrinkage rows are read afterward.
    const [tapCfgRes, tapCountRes, draftSellThrough, coldStorageRes, settingsRes, queuedSwapRes] = await Promise.all([
      supabase
        .from("tap_assignments")
        .select("tap_number, recipe_id, label, swap_variation_id, swap_volume_fl_oz, recipes(beer_name)")
        .order("tap_number"),
      supabase.from("system_settings").select("value").eq("key", "tap_count").maybeSingle(),
      fetchSellThrough(supabase, { packaging: "draft" }),
      supabase
        .from("cold_storage_inventory")
        .select("recipe_id, variation_id, quantity_on_hand")
        .not("recipe_id", "is", null),
      supabase.from("taproom_recipe_settings").select("recipe_id, is_retired"),
      // Queued beer-change swaps awaiting their Draft Restock ring. NO embed: this
      // table has two FKs to `recipes`, and constraint-name-disambiguated embeds
      // have crashed with PGRST200 here before (prod FK names are non-canonical).
      supabase
        .from("tap_swap_transitions")
        .select("id, tap_number, to_recipe_id, to_variation_id, opened_at")
        .is("consumed_source_ref", null)
        .order("opened_at"),
    ]);

    const tapCount = Number(tapCountRes.data?.value ?? 8);
    const taps     = tapCfgRes.data ?? [];
    const retiredIds = new Set(
      (settingsRes.data ?? []).filter((r) => r.is_retired).map((r) => r.recipe_id as string)
    );

    // Cold-storage on-hand per (recipe, packaging variation). Keyed by both because
    // the generic "1/6 Keg" variation is shared across beers — variation alone
    // would sum every recipe's kegs together.
    const onHandByRecipeVar = new Map<string, number>();
    for (const row of coldStorageRes.data ?? []) {
      const key = `${row.recipe_id}|${row.variation_id}`;
      onHandByRecipeVar.set(key, (onHandByRecipeVar.get(key) ?? 0) + Number(row.quantity_on_hand));
    }

    // Queued swaps, resolved to display names with two plain lookups (no embeds).
    const queuedRows = (queuedSwapRes.data ?? []) as {
      id: string; tap_number: number; to_recipe_id: string; to_variation_id: string; opened_at: string;
    }[];
    const queuedByTap = new Map<number, QueuedSwap>();
    if (queuedRows.length > 0) {
      const [incomingRecipes, incomingVariations] = await Promise.all([
        supabase.from("recipes").select("id, beer_name").in("id", queuedRows.map((r) => r.to_recipe_id)),
        supabase.from("packaging_variations").select("id, name").in("id", queuedRows.map((r) => r.to_variation_id)),
      ]);
      const beerById = new Map(
        (incomingRecipes.data ?? []).map((r) => [r.id as string, (r.beer_name as string | null) ?? "—"]),
      );
      const variationById = new Map(
        (incomingVariations.data ?? []).map((v) => [v.id as string, (v.name as string | null) ?? "—"]),
      );
      for (const r of queuedRows) {
        // FIFO: the oldest queued swap for a tap is the one the next ring consumes.
        if (queuedByTap.has(r.tap_number)) continue;
        queuedByTap.set(r.tap_number, {
          id:                 r.id,
          to_recipe_id:       r.to_recipe_id,
          to_beer_name:       beerById.get(r.to_recipe_id) ?? "—",
          to_variation_name:  variationById.get(r.to_variation_id) ?? "—",
          opened_at:          r.opened_at,
        });
      }
    }

    const emptyTaps = Array.from({ length: tapCount }, (_, i) => {
      const tap = taps.find((t) => t.tap_number === i + 1);
      return {
        tap_number: i + 1,
        recipe_id:  tap?.recipe_id ?? null,
        label:      tap?.label ?? null,
        beer_name:  (tap?.recipes as unknown as { beer_name: string } | null)?.beer_name ?? null,
        metrics:    null,
        queued_swap: queuedByTap.get(i + 1) ?? null,
      };
    });

    if (draftSellThrough.length === 0) {
      return NextResponse.json({ tap_count: tapCount, taps: emptyTaps, shrinkage_by_recipe: [] });
    }

    // Aggregate draft-on-tap per-recipe (multiple draft links possible, though rare).
    // The keg reserve is now sourced per-tap from the tap's swap keg (below), not
    // from keg sell-through, so it isn't aggregated here.
    const byRecipe = new Map<string, { beer_name: string; current_fl_oz: number; daily_fl_oz: number }>();
    for (const link of draftSellThrough) {
      const flOz  = link.current_bbl * BBL_TO_FL_OZ;
      const dFlOz = link.daily_sell_through_bbl * BBL_TO_FL_OZ;
      const entry = byRecipe.get(link.recipe_id);
      if (!entry) {
        byRecipe.set(link.recipe_id, {
          beer_name:     link.item_name ?? "—",
          current_fl_oz: flOz,
          daily_fl_oz:   dFlOz,
        });
      } else {
        entry.current_fl_oz += flOz;
        entry.daily_fl_oz   += dFlOz;
      }
    }

    // Deterministic shrinkage: read persisted per-swap rows for the window.
    const shrinkageStart = new Date(Date.now() - days * 86400000).toISOString();
    const { data: shrinkRows } = await supabase
      .from("draft_swap_shrinkage")
      .select("recipe_id, occurred_at, remaining_fl_oz, full_fl_oz")
      .gte("occurred_at", shrinkageStart);

    const beerNameByRecipe = new Map<string, string>(
      [...byRecipe.entries()].map(([id, v]) => [id, v.beer_name]),
    );
    const shrinkageByRecipe = aggregateShrinkage(
      (shrinkRows ?? []) as SwapShrinkageRow[],
      beerNameByRecipe,
    );

    const enrichedTaps = Array.from({ length: tapCount }, (_, i) => {
      const tap      = taps.find((t) => t.tap_number === i + 1) as
        | { tap_number: number; recipe_id: string | null; label: string | null;
            swap_variation_id: string | null; swap_volume_fl_oz: number | null;
            recipes: { beer_name: string } | null }
        | undefined;
      const recipeId = tap?.recipe_id ?? undefined;
      const metrics  = recipeId ? (byRecipe.get(recipeId) ?? null) : null;

      // Reserve = this tap's swap keg on hand in cold storage × its full-keg volume.
      const swapKegsOnHand = recipeId && tap?.swap_variation_id
        ? onHandByRecipeVar.get(`${recipeId}|${tap.swap_variation_id}`) ?? 0
        : 0;
      const reserveFlOz = swapReserveFlOz(swapKegsOnHand, tap?.swap_volume_fl_oz ?? null);

      return {
        tap_number: i + 1,
        recipe_id:  recipeId ?? null,
        label:      tap?.label ?? null,
        beer_name:  tap?.recipes?.beer_name ?? null,
        // The card keeps showing the OUTGOING beer and its real metrics; this only
        // adds the "incoming beer queued" hint until the ring flips the tap.
        queued_swap: queuedByTap.get(i + 1) ?? null,
        metrics: metrics ? {
          current_fl_oz:  Number(metrics.current_fl_oz.toFixed(1)),
          current_bbl:    Number(tapBblOnHand(metrics.current_fl_oz, reserveFlOz).toFixed(3)),
          draft_bbl:      Number((metrics.current_fl_oz / BBL_TO_FL_OZ).toFixed(3)),
          keg_bbl:        Number((reserveFlOz / BBL_TO_FL_OZ).toFixed(3)),
          daily_fl_oz:    Number(metrics.daily_fl_oz.toFixed(1)),
          daily_bbl:      Number((metrics.daily_fl_oz / BBL_TO_FL_OZ).toFixed(4)),
          is_retired:     retiredIds.has(recipeId!),
        } : null,
      };
    });

    return NextResponse.json({
      tap_count:           tapCount,
      taps:                enrichedTaps,
      shrinkage_by_recipe: shrinkageByRecipe,
    });
  } catch (err) {
    return apiError(err);
  }
}
