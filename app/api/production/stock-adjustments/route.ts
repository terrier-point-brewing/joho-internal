import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("stock_adjustments")
    .select("*, ingredients(name, unit), brew_batches(beer_name, batch_number)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ingredient_id, type, quantity, new_total, note } = body;

  let delta: number;

  if (type === "inventory_count") {
    const { data: ing } = await supabase
      .from("ingredients")
      .select("stock_quantity")
      .eq("id", ingredient_id)
      .single();
    delta = (new_total ?? 0) - (ing?.stock_quantity ?? 0);
  } else if (type === "received") {
    delta = Math.abs(quantity);
  } else {
    // used, waste — stored as negative
    delta = -Math.abs(quantity);
  }

  const { data: adj, error: adjErr } = await supabase
    .from("stock_adjustments")
    .insert({ ingredient_id, type, quantity: delta, note: note || null })
    .select()
    .single();

  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 });

  // Update stock quantity atomically
  if (type === "inventory_count") {
    await supabase.from("ingredients").update({ stock_quantity: new_total }).eq("id", ingredient_id);
  } else {
    await supabase.rpc("adjust_ingredient_stock", { p_id: ingredient_id, p_delta: delta });
  }

  return NextResponse.json(adj, { status: 201 });
}
