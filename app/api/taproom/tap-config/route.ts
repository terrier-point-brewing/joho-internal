import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const [countRes, restockItemRes, tapsRes] = await Promise.all([
    supabase.from("system_settings").select("value").eq("key", "tap_count").maybeSingle(),
    supabase.from("system_settings").select("value").eq("key", "draft_restock_item_id").maybeSingle(),
    supabase
      .from("tap_assignments")
      // `swap_volume_fl_oz` is DERIVED, not stored — it is the swap keg's own
      // coded volume, joined through swap_variation_id. Plain (unnamed) embed:
      // tap_assignments has exactly one FK into packaging_variations, so there
      // is nothing to disambiguate and no non-canonical constraint name to
      // depend on (see the PGRST200 note on tap_swap_transitions elsewhere).
      .select("tap_number, recipe_id, label, restock_variation_id, swap_variation_id, recipes(beer_name), packaging_variations(total_volume_fl_oz)")
      .order("tap_number"),
  ]);
  type TapRow = {
    tap_number: number;
    recipe_id: string | null;
    label: string | null;
    restock_variation_id: string | null;
    swap_variation_id: string | null;
    recipes: { beer_name: string } | null;
    packaging_variations: { total_volume_fl_oz: number | null } | null;
  };
  // Flattened back onto the same wire field the UI has always read, so callers
  // see no change — only the storage went away.
  const taps = ((tapsRes.data ?? []) as unknown as TapRow[]).map(
    ({ packaging_variations, ...tap }) => ({
      ...tap,
      swap_volume_fl_oz: packaging_variations?.total_volume_fl_oz ?? null,
    }),
  );
  return NextResponse.json({
    tap_count: Number(countRes.data?.value ?? 8),
    // The Square catalog item id chosen as the "Draft Restock" item — scopes the
    // per-tap variation pickers in the UI. Stored as text in system_settings.
    draft_restock_item_id: (restockItemRes.data?.value as string | null) ?? null,
    taps,
  });
}

export async function PUT(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const adminSupabase = createSupabaseAdminClient();
  try {
    const body = await req.json() as {
      tap_count?: number;
      draft_restock_item_id?: string | null;
      taps?: {
        tap_number: number;
        recipe_id: string | null;
        label?: string;
        restock_variation_id?: string | null;
        swap_variation_id?: string | null;
        // NOTE: no swap_volume_fl_oz. The full-keg recount target is the swap
        // keg's coded volume and is read back through the join above; accepting
        // it here is what let a stale hand-entered 660 round-trip through the
        // editor and outlive the 661 on its own variation.
      }[];
    };
    const { tap_count, draft_restock_item_id, taps } = body;

    if (tap_count !== undefined) {
      await adminSupabase
        .from("system_settings")
        .upsert(
          { key: "tap_count", value: tap_count, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
    }

    if (draft_restock_item_id !== undefined) {
      await adminSupabase
        .from("system_settings")
        .upsert(
          { key: "draft_restock_item_id", value: draft_restock_item_id, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
    }

    if (taps !== undefined) {
      for (const tap of taps) {
        await supabase
          .from("tap_assignments")
          .upsert(
            {
              tap_number:           tap.tap_number,
              recipe_id:            tap.recipe_id || null,
              label:                tap.label || null,
              restock_variation_id: tap.restock_variation_id || null,
              swap_variation_id:    tap.swap_variation_id || null,
              updated_at:           new Date().toISOString(),
            },
            { onConflict: "tap_number" }
          );
      }
      // Remove any tap numbers that exceed the new count
      const effectiveCount = tap_count ?? 999;
      await supabase.from("tap_assignments").delete().gt("tap_number", effectiveCount);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
