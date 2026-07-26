import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const allowed = ["recipient_id", "recipient_name", "quantity", "variant_label", "volume_bbl", "notes", "status"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];

  const { data, error } = await supabase
    .from("export_transactions")
    .update(updates)
    .eq("id", id)
    .select("*, brew_batches(id, beer_name, batch_number)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("export_transactions").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
