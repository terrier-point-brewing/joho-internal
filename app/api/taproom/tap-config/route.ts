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
      .select("tap_number, recipe_id, label, restock_variation_id, swap_variation_id, swap_volume_fl_oz, recipes(beer_name)")
      .order("tap_number"),
  ]);
  return NextResponse.json({
    tap_count: Number(countRes.data?.value ?? 8),
    // The Square catalog item id chosen as the "Draft Restock" item — scopes the
    // per-tap variation pickers in the UI. Stored as text in system_settings.
    draft_restock_item_id: (restockItemRes.data?.value as string | null) ?? null,
    taps: tapsRes.data ?? [],
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
        swap_volume_fl_oz?: number | null;
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
              swap_volume_fl_oz:    tap.swap_volume_fl_oz ?? null,
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
