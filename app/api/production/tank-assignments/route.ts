import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  // Returns all active (unreleased) assignments with batch + tank info
  const { data, error } = await supabase
    .from("batch_tank_assignments")
    .select("*, brew_batches(id, beer_name, batch_number, status, volume_bbl)")
    .is("released_at", null)
    .order("assigned_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { batch_id, tank_id, notes } = body;

  // Check tank isn't already occupied
  const { data: existing } = await supabase
    .from("batch_tank_assignments")
    .select("id")
    .eq("tank_id", tank_id)
    .is("released_at", null)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "Tank is already occupied" }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("batch_tank_assignments")
    .insert({ batch_id, tank_id, notes: notes || null })
    .select("*, brew_batches(id, beer_name, batch_number, status, volume_bbl)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
