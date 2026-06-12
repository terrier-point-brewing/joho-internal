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
    const { recipe_id, is_retired, retired_notes } = await req.json() as {
      recipe_id: string;
      is_retired: boolean;
      retired_notes?: string;
    };
    if (!recipe_id) return NextResponse.json({ error: "recipe_id required" }, { status: 400 });

    const { data, error } = await supabase
      .from("taproom_recipe_settings")
      .upsert(
        {
          recipe_id,
          is_retired: Boolean(is_retired),
          retired_at:    is_retired ? new Date().toISOString() : null,
          retired_notes: retired_notes || null,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: "recipe_id" }
      )
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}
