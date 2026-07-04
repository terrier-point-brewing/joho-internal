import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("taproom_recipe_settings").select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function PATCH(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const body = await req.json() as {
      recipe_id: string;
      is_retired?: boolean;
      retired_notes?: string;
      swap_variation_id?: string | null;
      swap_volume_fl_oz?: number | null;
    };
    const { recipe_id } = body;
    if (!recipe_id) return NextResponse.json({ error: "recipe_id required" }, { status: 400 });

    // Upsert only the fields the caller actually sent so setting swap config
    // doesn't clobber retirement state (and vice-versa).
    const payload: Record<string, unknown> = {
      recipe_id,
      updated_at: new Date().toISOString(),
    };

    if ("is_retired" in body) {
      const is_retired = Boolean(body.is_retired);
      payload.is_retired = is_retired;
      payload.retired_at = is_retired ? new Date().toISOString() : null;
      payload.retired_notes = body.retired_notes || null;
    }

    if ("swap_variation_id" in body) {
      const swap_variation_id = body.swap_variation_id;
      if (swap_variation_id != null && typeof swap_variation_id !== "string") {
        return NextResponse.json({ error: "swap_variation_id must be a string" }, { status: 400 });
      }
      payload.swap_variation_id = swap_variation_id ?? null;
    }

    if ("swap_volume_fl_oz" in body) {
      const raw = body.swap_volume_fl_oz;
      if (raw == null) {
        payload.swap_volume_fl_oz = null;
      } else {
        const swap_volume_fl_oz = Number(raw);
        if (!Number.isFinite(swap_volume_fl_oz) || swap_volume_fl_oz <= 0) {
          return NextResponse.json({ error: "swap_volume_fl_oz must be a positive number" }, { status: 400 });
        }
        payload.swap_volume_fl_oz = swap_volume_fl_oz;
      }
    }

    const { data, error } = await supabase
      .from("taproom_recipe_settings")
      .upsert(payload, { onConflict: "recipe_id" })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}
