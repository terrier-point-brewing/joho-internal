import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("batch_exports")
    .select("*, brew_batches(id, beer_name, batch_number)")
    .order("exported_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { batch_id, channel, recipient_id, recipient_name, product_type, quantity, unit, volume_bbl, notes } = body;

  if (!batch_id || !channel || !product_type || quantity == null) {
    return NextResponse.json({ error: "batch_id, channel, product_type, quantity required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("batch_exports")
    .insert({ batch_id, channel, recipient_id: recipient_id || null, recipient_name: recipient_name || null, product_type, quantity, unit: unit || "units", volume_bbl: volume_bbl || null, notes: notes || null })
    .select("*, brew_batches(id, beer_name, batch_number)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
