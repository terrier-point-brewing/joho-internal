import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { aggregateShrinkage, type SwapShrinkageRow } from "@/lib/reports/draftShrinkage";
import { swapReserveFlOz, tapBblOnHand } from "@/lib/reports/draftTapMetrics";
import { allTapBookingGaps, type TapBookingInput } from "@/lib/reports/draftBookingGap";
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
        // Full-keg volume is DERIVED from the swap keg's own variation, never
        // stored on the tap. Plain embed — tap_assignments has a single FK into
        // packaging_variations, so there is no constraint name to get wrong.
        // last_restock_at rides along for the booking-gap check: it is the only
        // record that a keg was ever actually booked onto this tap.
        .select("tap_number, recipe_id, label, swap_variation_id, last_restock_at, recipes(beer_name), packaging_variations(total_volume_fl_oz)")
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
    //
    // Deliberately non-fatal: a failure here costs the "queued" badges, not the
    // whole tab. But it is NOT swallowed — before migration 20260816 is applied
    // this is a PGRST205 ("table not in schema cache"), and that must be visible
    // in the server log rather than looking like "no swaps queued".
    if (queuedSwapRes.error) {
      console.error("[draft-stats] queued swap lookup failed", queuedSwapRes.error.message);
    }
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
      return NextResponse.json({ tap_count: tapCount, taps: emptyTaps, shrinkage_by_recipe: [], booking_gaps: [] });
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

    // Deterministic shrinkage: read persisted per-keg rows for the window.
    // `cause` comes along so beer-change dumps can be held out of the average.
    const shrinkageStart = new Date(Date.now() - days * 86400000).toISOString();
    const { data: shrinkRows } = await supabase
      .from("draft_swap_shrinkage")
      .select("recipe_id, occurred_at, unaccounted_fl_oz, full_fl_oz, cause")
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
            swap_variation_id: string | null;
            recipes: { beer_name: string } | null;
            packaging_variations: { total_volume_fl_oz: number | null } | null }
        | undefined;
      const recipeId = tap?.recipe_id ?? undefined;
      const metrics  = recipeId ? (byRecipe.get(recipeId) ?? null) : null;

      // Reserve = this tap's swap keg on hand in cold storage × its full-keg volume.
      const swapKegsOnHand = recipeId && tap?.swap_variation_id
        ? onHandByRecipeVar.get(`${recipeId}|${tap.swap_variation_id}`) ?? 0
        : 0;
      const reserveFlOz = swapReserveFlOz(
        swapKegsOnHand,
        tap?.packaging_variations?.total_volume_fl_oz ?? null,
      );

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

    // ── Kegs that went on a tap with no Draft Restock behind them ─────────────
    //
    // Pour totals come from draft_pour_consumption, which is keyed by recipe and
    // business_date. Compared against each tap's last_restock_at, they answer the
    // one question the tap card cannot: did the beer that poured have a keg
    // booked out of cold storage for it?
    //
    // Non-fatal by design — a failure here costs the warning banner, not the tab.
    let bookingGaps: ReturnType<typeof allTapBookingGaps> = [];
    try {
      const tappedRecipeIds = [...new Set(taps.map((t) => t.recipe_id).filter(Boolean))] as string[];
      if (tappedRecipeIds.length > 0) {
        const { data: pours, error: pourErr } = await supabase
          .from("draft_pour_consumption")
          .select("recipe_id, business_date, fl_oz")
          .in("recipe_id", tappedRecipeIds);
        if (pourErr) throw new Error(pourErr.message);

        const pourRows = (pours ?? []) as { recipe_id: string; business_date: string; fl_oz: number | string }[];
        const inputs: TapBookingInput[] = [];
        for (const t of taps) {
          const tapRow = t as unknown as {
            tap_number: number; recipe_id: string | null; swap_variation_id: string | null;
            last_restock_at: string | null;
            recipes: { beer_name: string } | null;
            packaging_variations: { total_volume_fl_oz: number | null } | null;
          };
          if (!tapRow.recipe_id) continue;
          if (retiredIds.has(tapRow.recipe_id)) continue; // a retired beer is not pouring

          // Strictly AFTER the restock DATE. Pours on the day of a swap include
          // the outgoing keg's tail, and counting those against the incoming keg
          // is how a correct booking would get flagged.
          const restockDate = tapRow.last_restock_at ? tapRow.last_restock_at.slice(0, 10) : null;
          let sinceFlOz = 0;
          let everFlOz = 0;
          for (const p of pourRows) {
            if (p.recipe_id !== tapRow.recipe_id) continue;
            const oz = Number(p.fl_oz) || 0;
            everFlOz += oz;
            if (restockDate === null || p.business_date > restockDate) sinceFlOz += oz;
          }

          inputs.push({
            tapNumber: tapRow.tap_number,
            beerName: tapRow.recipes?.beer_name?.trim() ?? null,
            lastRestockAt: tapRow.last_restock_at,
            pouredSinceRestockFlOz: sinceFlOz,
            pouredEverFlOz: everFlOz,
            swapKegFlOz: tapRow.packaging_variations?.total_volume_fl_oz ?? null,
            swapKegsOnHand: tapRow.swap_variation_id
              ? onHandByRecipeVar.get(`${tapRow.recipe_id}|${tapRow.swap_variation_id}`) ?? 0
              : 0,
          });
        }
        bookingGaps = allTapBookingGaps(inputs);
      }
    } catch (e) {
      console.error("[draft-stats] booking-gap check failed", e instanceof Error ? e.message : e);
    }

    return NextResponse.json({
      tap_count:           tapCount,
      taps:                enrichedTaps,
      shrinkage_by_recipe: shrinkageByRecipe,
      booking_gaps:        bookingGaps,
    });
  } catch (err) {
    return apiError(err);
  }
}
