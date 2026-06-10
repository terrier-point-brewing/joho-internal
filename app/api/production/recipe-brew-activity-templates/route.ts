import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { recipe_id, sort_order, activity, time_label, temp, temp_unit, amount, amount_unit, vsp } = body;
  if (!recipe_id || !activity) {
    return NextResponse.json({ error: "recipe_id and activity are required" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("recipe_brew_activity_templates")
    .insert({
      recipe_id,
      sort_order:  sort_order ?? 0,
      activity,
      time_label:  time_label  || null,
      temp:        temp        ?? null,
      temp_unit:   temp_unit   ?? "F",
      amount:      amount      ?? null,
      amount_unit: amount_unit ?? null,
      vsp:         vsp         ?? null,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const ALLOWED = ["sort_order", "activity", "time_label", "temp", "temp_unit", "amount", "amount_unit", "vsp"] as const;
  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (k in updates) patch[k] = updates[k];
  }

  const { data, error } = await supabase
    .from("recipe_brew_activity_templates")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_brew_activity_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
