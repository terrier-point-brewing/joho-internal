import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .order("event_start", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { event_name, event_start, event_end, event_host, notes } = await req.json();

  if (!event_name || !event_start || !event_end || !event_host) {
    return NextResponse.json({ error: "event_name, event_start, event_end, and event_host are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("events")
    .insert({ event_name, event_start, event_end, event_host, notes: notes || null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
