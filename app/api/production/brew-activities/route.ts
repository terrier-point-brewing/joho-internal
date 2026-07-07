import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Single brew_activities row CRUD, scoped by whichever parent id the caller
// sends. recipe-scoped rows carry recipe_id; batch-scoped rows carry batch_id.
// (Library-template steps are managed in bulk by the brew-step-templates route.)
const ALLOWED = ["sort_order", "activity", "time_label", "temp", "temp_unit", "amount", "amount_unit", "vsp"] as const;

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const { recipe_id, batch_id, sort_order, activity, time_label, temp, temp_unit, amount, amount_unit, vsp } = body;

  if (!activity) {
    return NextResponse.json({ error: "activity is required" }, { status: 400 });
  }
  if ((recipe_id ? 1 : 0) + (batch_id ? 1 : 0) !== 1) {
    return NextResponse.json({ error: "exactly one of recipe_id or batch_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("brew_activities")
    .insert({
      recipe_id:   recipe_id ?? null,
      batch_id:    batch_id  ?? null,
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
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    if (k in updates) patch[k] = updates[k];
  }

  const { data, error } = await supabase
    .from("brew_activities")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("brew_activities").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
