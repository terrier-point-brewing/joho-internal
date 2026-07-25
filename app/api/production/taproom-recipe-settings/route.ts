import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildRetirePayload } from "@/lib/taproom/retireRecipe";

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
    };
    const { recipe_id } = body;
    if (!recipe_id) return NextResponse.json({ error: "recipe_id required" }, { status: 400 });

    // Upsert only the fields the caller actually sent so setting one field
    // doesn't clobber the others. Swap config now lives per-tap (tap_assignments);
    // this route keeps only retirement state.
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      recipe_id,
      updated_at: now,
    };

    // Shared with the tap-swap queue route, which retires the outgoing beer.
    if ("is_retired" in body) {
      Object.assign(
        payload,
        buildRetirePayload(recipe_id, Boolean(body.is_retired), now, body.retired_notes),
      );
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
