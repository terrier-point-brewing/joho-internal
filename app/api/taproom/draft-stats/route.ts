import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { fetchPhysicalCounts, type PhysicalCount } from "@/lib/square/inventory";
import { apiError } from "@/lib/utils/api";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

// A full sixth-barrel keg (~660 fl oz). Counts at or above this threshold
// indicate a fresh keg was just tapped.
const FULL_KEG_FL_OZ = 660;
const FULL_KEG_THRESHOLD = 580;

interface KegEvent {
  date: string;
  shrinkage_fl_oz: number;
  shrinkage_pct: number;
}

function detectKegEvents(counts: PhysicalCount[]): KegEvent[] {
  const sorted = [...counts].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const events: KegEvent[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = parseFloat(sorted[i - 1].quantity);
    const curr = parseFloat(sorted[i].quantity);
    if (curr >= FULL_KEG_THRESHOLD && prev < FULL_KEG_THRESHOLD) {
      events.push({
        date:            sorted[i].occurred_at.slice(0, 10),
        shrinkage_fl_oz: Number(prev.toFixed(1)),
        shrinkage_pct:   Number((prev / FULL_KEG_FL_OZ * 100).toFixed(1)),
      });
    }
  }
  return events;
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const days = Math.min(parseInt(new URL(req.url).searchParams.get("days") ?? "90"), 365);

    // Fetch tap config, sell-through data (draft only), and retired settings in parallel.
    // Shrinkage physical counts depend on the draft variation IDs, so they run after.
    const [tapCfgRes, tapCountRes, draftSellThrough, kegSellThrough, settingsRes] = await Promise.all([
      supabase
        .from("tap_assignments")
        .select("tap_number, recipe_id, label, recipes(beer_name)")
        .order("tap_number"),
      supabase.from("system_settings").select("value").eq("key", "tap_count").maybeSingle(),
      fetchSellThrough(supabase, { packaging: "draft" }),
      fetchSellThrough(supabase, { packaging: "keg" }),
      supabase.from("taproom_recipe_settings").select("recipe_id, is_retired"),
    ]);

    const tapCount = Number(tapCountRes.data?.value ?? 8);
    const taps     = tapCfgRes.data ?? [];
    const retiredIds = new Set(
      (settingsRes.data ?? []).filter((r) => r.is_retired).map((r) => r.recipe_id as string)
    );

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

    // Keg inventory per recipe (packaged kegs in reserve, not yet on tap)
    const kegBblByRecipe = new Map<string, number>();
    for (const link of kegSellThrough) {
      kegBblByRecipe.set(link.recipe_id, (kegBblByRecipe.get(link.recipe_id) ?? 0) + link.current_bbl);
    }

    // Aggregate per-recipe (multiple draft links possible, though rare)
    const byRecipe = new Map<string, { beer_name: string; current_fl_oz: number; daily_fl_oz: number; keg_bbl: number }>();
    for (const link of draftSellThrough) {
      const flOz  = link.current_bbl * BBL_TO_FL_OZ;
      const dFlOz = link.daily_sell_through_bbl * BBL_TO_FL_OZ;
      const entry = byRecipe.get(link.recipe_id);
      if (!entry) {
        byRecipe.set(link.recipe_id, {
          beer_name:     link.item_name ?? "—",
          current_fl_oz: flOz,
          daily_fl_oz:   dFlOz,
          keg_bbl:       kegBblByRecipe.get(link.recipe_id) ?? 0,
        });
      } else {
        entry.current_fl_oz += flOz;
        entry.daily_fl_oz   += dFlOz;
      }
    }

    // Shrinkage: physical count history on the base draft variations
    const draftVarIds = draftSellThrough.map((l) => l.square_variation_id);
    const shrinkageStart = new Date(Date.now() - days * 86400000);
    const now = new Date();

    const physicalCounts = await fetchPhysicalCounts(
      shrinkageStart.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
      draftVarIds,
    ).catch((): PhysicalCount[] => []);

    const varToRecipeId = new Map(draftSellThrough.map((l) => [l.square_variation_id, l.recipe_id]));
    const varToName     = new Map(draftSellThrough.map((l) => [l.square_variation_id, l.item_name ?? "—"]));

    const countsByVar = new Map<string, PhysicalCount[]>();
    for (const pc of physicalCounts) {
      const arr = countsByVar.get(pc.catalog_object_id) ?? [];
      arr.push(pc);
      countsByVar.set(pc.catalog_object_id, arr);
    }

    const eventsByRecipe = new Map<string, KegEvent[]>();
    for (const [varId, counts] of countsByVar) {
      const recipeId = varToRecipeId.get(varId);
      if (!recipeId) continue;
      const existing = eventsByRecipe.get(recipeId) ?? [];
      eventsByRecipe.set(recipeId, [...existing, ...detectKegEvents(counts)]);
    }

    const shrinkageByRecipe = [...eventsByRecipe.entries()]
      .map(([recipeId, rawEvents]) => {
        const events = [...rawEvents].sort((a, b) => a.date.localeCompare(b.date));
        const avg = events.length > 0
          ? events.reduce((s, e) => s + e.shrinkage_fl_oz, 0) / events.length
          : 0;
        return {
          recipe_id:           recipeId,
          beer_name:           byRecipe.get(recipeId)?.beer_name ?? varToName.get(recipeId) ?? "—",
          events,
          avg_shrinkage_fl_oz: Number(avg.toFixed(1)),
          avg_shrinkage_pct:   Number((avg / FULL_KEG_FL_OZ * 100).toFixed(1)),
          keg_count:           events.length,
        };
      })
      .sort((a, b) => b.avg_shrinkage_fl_oz - a.avg_shrinkage_fl_oz);

    const enrichedTaps = Array.from({ length: tapCount }, (_, i) => {
      const tap      = taps.find((t) => t.tap_number === i + 1);
      const recipeId = tap?.recipe_id as string | undefined;
      const metrics  = recipeId ? (byRecipe.get(recipeId) ?? null) : null;
      return {
        tap_number: i + 1,
        recipe_id:  recipeId ?? null,
        label:      tap?.label ?? null,
        beer_name:  (tap?.recipes as unknown as { beer_name: string } | null)?.beer_name ?? null,
        metrics: metrics ? {
          current_fl_oz:  Number(metrics.current_fl_oz.toFixed(1)),
          current_bbl:    Number((metrics.current_fl_oz / BBL_TO_FL_OZ + metrics.keg_bbl).toFixed(3)),
          draft_bbl:      Number((metrics.current_fl_oz / BBL_TO_FL_OZ).toFixed(3)),
          keg_bbl:        Number(metrics.keg_bbl.toFixed(3)),
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
