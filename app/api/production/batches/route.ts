import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, style)")
    .order("brew_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { beer_name, batch_number, brew_date, volume_bbl, turns, status, notes, recipe_id } = body;

  const { data, error } = await supabase
    .from("brew_batches")
    .insert({ beer_name, batch_number, brew_date, volume_bbl, turns, status, notes, recipe_id: recipe_id || null })
    .select("*, recipes(beer_name, style)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
