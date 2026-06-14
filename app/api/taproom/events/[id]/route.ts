import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { event_name, event_start, event_end, event_host, notes } = await req.json();

  const { data, error } = await supabase
    .from("events")
    .update({ event_name, event_start, event_end, event_host, notes: notes || null })
    .eq("id", params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireRole("manager"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("events").delete().eq("id", params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
