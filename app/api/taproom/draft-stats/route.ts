import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { aggregateShrinkage, type SwapShrinkageRow } from "@/lib/reports/draftShrinkage";
import { swapReserveFlOz, tapBblOnHand } from "@/lib/reports/draftTapMetrics";
import { apiError } from "@/lib/utils/api";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const days = Math.min(parseInt(new URL(req.url).searchParams.get("days") ?? "90"), 365);

    // Fetch tap config, sell-through data (draft only), swap-keg cold storage, and
    // retired settings in parallel. Shrinkage rows are read afterward.
    const [tapCfgRes, tapCountRes, draftSellThrough, coldStorageRes, settingsRes] = await Promise.all([
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

    const emptyTaps = Array.from({ length: tapCount }, (_, i) => {
      const tap = taps.find((t) => t.tap_number === i + 1);
      return {
        tap_number: i + 1,
        recipe_id:  tap?.recipe_id ?? null,
        label:      tap?.label ?? null,
        beer_name:  (tap?.recipes as unknown as { beer_name: string } | null)?.beer_name ?? null,
        metrics:    null,
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
