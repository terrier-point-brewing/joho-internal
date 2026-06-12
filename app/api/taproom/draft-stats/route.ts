import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  fetchCurrentCounts,
  fetchOrderSales,
  fetchPhysicalCounts,
  type PhysicalCount,
} from "@/lib/square/inventory";
import { apiError } from "@/lib/utils/api";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 28;
// A full sixth-barrel keg (~660 fl oz). Counts at or above this threshold
// indicate a fresh keg was just tapped.
const FULL_KEG_FL_OZ = 660;
const FULL_KEG_THRESHOLD = 580;

function ozFromVariationName(name: string | null): number | null {
  if (!name) return null;
  const m = name.match(/(\d+(?:\.\d+)?)oz/i);
  return m ? parseFloat(m[1]) : null;
}

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
    // Keg replacement: count jumps from below threshold back to full
    if (curr >= FULL_KEG_THRESHOLD && prev < FULL_KEG_THRESHOLD) {
      events.push({
        date:           sorted[i].occurred_at.slice(0, 10),
        shrinkage_fl_oz: Number(prev.toFixed(1)),
        shrinkage_pct:  Number((prev / FULL_KEG_FL_OZ * 100).toFixed(1)),
      });
    }
  }
  return events;
}

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const days = Math.min(parseInt(new URL(req.url).searchParams.get("days") ?? "90"), 365);

    const [tapCfgRes, tapCountRes, linksRes, settingsRes] = await Promise.all([
      supabase
        .from("tap_assignments")
        .select("tap_number, recipe_id, label, recipes(beer_name)")
        .order("tap_number"),
      supabase.from("system_settings").select("value").eq("key", "tap_count").maybeSingle(),
      supabase
        .from("recipe_square_links")
        .select("recipe_id, square_variation_id, variation_name, item_name")
        .eq("packaging", "draft"),
      supabase.from("taproom_recipe_settings").select("recipe_id, is_retired"),
    ]);

    const tapCount = Number(tapCountRes.data?.value ?? 8);
    const taps = tapCfgRes.data ?? [];
    const draftLinks = linksRes.data ?? [];
    const retiredIds = new Set(
      (settingsRes.data ?? []).filter((r) => r.is_retired).map((r) => r.recipe_id as string)
    );

    if (draftLinks.length === 0) {
      return NextResponse.json({
        tap_count: tapCount,
        taps: Array.from({ length: tapCount }, (_, i) => {
          const tap = taps.find((t) => t.tap_number === i + 1);
          return {
            tap_number: i + 1,
            recipe_id: tap?.recipe_id ?? null,
            label: tap?.label ?? null,
            beer_name: (tap?.recipes as { beer_name: string } | null)?.beer_name ?? null,
            metrics: null,
          };
        }),
        shrinkage_by_recipe: [],
      });
    }

    const variationIds = draftLinks.map((l) => l.square_variation_id as string);
    const now   = new Date();
    const windowStart    = new Date(now.getTime() - WINDOW_DAYS * 86400000);
    const shrinkageStart = new Date(now.getTime() - days * 86400000);

    const [currentCounts, salesTotals, physicalCounts] = await Promise.all([
      fetchCurrentCounts(variationIds),
      fetchOrderSales(
        windowStart.toISOString().slice(0, 10),
        now.toISOString().slice(0, 10),
        variationIds,
      ),
      fetchPhysicalCounts(
        shrinkageStart.toISOString().slice(0, 10),
        now.toISOString().slice(0, 10),
        variationIds,
      ).catch((): PhysicalCount[] => []),
    ]);

    // Aggregate per-recipe draft metrics
    const byRecipe = new Map<string, {
      beer_name: string;
      current_fl_oz: number;
      daily_fl_oz: number;
    }>();

    for (const link of draftLinks) {
      const recipeId = link.recipe_id as string;
      const varId    = link.square_variation_id as string;
      const ozPerUnit = ozFromVariationName(link.variation_name as string | null);

      // Current inventory: qty from Square (unit count for POS items)
      // multiplied by oz per serving to get total fl oz estimate
      const qty        = currentCounts.get(varId) ?? 0;
      const currentFlOz = ozPerUnit ? qty * ozPerUnit : qty;

      const totalSold   = salesTotals.get(varId) ?? 0;
      const dailyFlOz   = ozPerUnit ? (totalSold / WINDOW_DAYS) * ozPerUnit : 0;

      const entry = byRecipe.get(recipeId);
      if (!entry) {
        byRecipe.set(recipeId, {
          beer_name:     link.item_name as string ?? "—",
          current_fl_oz: currentFlOz,
          daily_fl_oz:   dailyFlOz,
        });
      } else {
        entry.current_fl_oz += currentFlOz;
        entry.daily_fl_oz   += dailyFlOz;
      }
    }

    // Build shrinkage history by recipe from physical counts
    const countsByVar = new Map<string, PhysicalCount[]>();
    for (const pc of physicalCounts) {
      const arr = countsByVar.get(pc.catalog_object_id) ?? [];
      arr.push(pc);
      countsByVar.set(pc.catalog_object_id, arr);
    }

    const varToRecipeId = new Map(
      draftLinks.map((l) => [l.square_variation_id as string, l.recipe_id as string])
    );
    const varToName = new Map(
      draftLinks.map((l) => [l.square_variation_id as string, l.item_name as string ?? "—"])
    );

    const eventsByRecipe = new Map<string, KegEvent[]>();
    for (const [varId, counts] of countsByVar) {
      const recipeId = varToRecipeId.get(varId);
      if (!recipeId) continue;
      const events = detectKegEvents(counts);
      const existing = eventsByRecipe.get(recipeId) ?? [];
      eventsByRecipe.set(recipeId, [...existing, ...events]);
    }

    const shrinkageByRecipe = [...eventsByRecipe.entries()].map(([recipeId, rawEvents]) => {
      const events = [...rawEvents].sort((a, b) => a.date.localeCompare(b.date));
      const avg = events.length > 0
        ? events.reduce((s, e) => s + e.shrinkage_fl_oz, 0) / events.length
        : 0;
      const beerName = byRecipe.get(recipeId)?.beer_name ?? varToName.get(recipeId) ?? "—";
      return {
        recipe_id:           recipeId,
        beer_name:           beerName,
        events,
        avg_shrinkage_fl_oz: Number(avg.toFixed(1)),
        avg_shrinkage_pct:   Number((avg / FULL_KEG_FL_OZ * 100).toFixed(1)),
        keg_count:           events.length,
      };
    }).sort((a, b) => b.avg_shrinkage_fl_oz - a.avg_shrinkage_fl_oz);

    // Enrich taps with per-recipe metrics
    const enrichedTaps = Array.from({ length: tapCount }, (_, i) => {
      const tap      = taps.find((t) => t.tap_number === i + 1);
      const recipeId = tap?.recipe_id as string | undefined;
      const metrics  = recipeId ? (byRecipe.get(recipeId) ?? null) : null;
      return {
        tap_number: i + 1,
        recipe_id:  recipeId ?? null,
        label:      tap?.label ?? null,
        beer_name:  (tap?.recipes as { beer_name: string } | null)?.beer_name ?? null,
        metrics: metrics
          ? {
              current_fl_oz:    Number(metrics.current_fl_oz.toFixed(1)),
              current_bbl:      Number((metrics.current_fl_oz / BBL_TO_FL_OZ).toFixed(3)),
              daily_fl_oz:      Number(metrics.daily_fl_oz.toFixed(1)),
              daily_bbl:        Number((metrics.daily_fl_oz / BBL_TO_FL_OZ).toFixed(4)),
              is_retired:       retiredIds.has(recipeId!),
            }
          : null,
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
