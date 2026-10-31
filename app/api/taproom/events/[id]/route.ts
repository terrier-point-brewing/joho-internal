import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { event_name, event_start, event_end, event_host, notes } = await req.json();

  const { data, error } = await supabase
    .from("events")
    .update({ event_name, event_start, event_end, event_host, notes: notes || null })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  // An event whose kegs were recorded has shipment rows stamped with its id.
  // Those only reverse in Production, so the event stays until they do.
  const { data: existing } = await supabase.from("events").select("closed_at").eq("id", id).maybeSingle();
  if (existing?.closed_at) {
    return NextResponse.json({ error: "This event has kegs recorded. Ask Production to reverse the shipment before deleting it." }, { status: 409 });
  }
  const { error } = await supabase.from("events").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
