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
  const { ingredient_id, type, quantity, new_total, note, purchase_cost, shipping_cost } = body;

  // Fetch current ingredient state upfront (needed for all paths)
  const { data: ing } = await supabase
    .from("ingredients")
    .select("stock_quantity, cost_per_unit, unit")
    .eq("id", ingredient_id)
    .single();

  const currentQty  = ing?.stock_quantity ?? 0;
  const currentCost = ing?.cost_per_unit  ?? null;

  let delta: number;
  if (type === "inventory_count") {
    delta = (new_total ?? 0) - currentQty;
  } else if (type === "received") {
    delta = Math.abs(quantity);
  } else {
    delta = -Math.abs(quantity);
  }

  // Cost tracking
  let adjCostPerUnit: number | null = currentCost;
  let totalValueChange: number | null = currentCost != null ? delta * currentCost : null;
  let newCostPerUnit: number | null = currentCost;

  if (type === "received" && purchase_cost != null && Number(purchase_cost) > 0) {
    adjCostPerUnit   = Number(purchase_cost);
    totalValueChange = delta * adjCostPerUnit;
    // Weighted average cost
    const totalQty = currentQty + delta;
    newCostPerUnit = totalQty > 0
      ? ((currentQty * (currentCost ?? 0)) + (delta * adjCostPerUnit)) / totalQty
      : adjCostPerUnit;
  }

  const { data: adj, error: adjErr } = await supabase
    .from("stock_adjustments")
    .insert({
      ingredient_id,
      type,
      quantity:           delta,
      note:               note || null,
      cost_per_unit:      adjCostPerUnit,
      total_value_change: totalValueChange,
      shipping_cost:      shipping_cost != null && Number(shipping_cost) > 0 ? Number(shipping_cost) : null,
      unit:               ing?.unit ?? null,   // snapshot unit at write time
    })
    .select()
    .single();

  if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 });

  // Update stock quantity
  if (type === "inventory_count") {
    await supabase.from("ingredients").update({ stock_quantity: new_total }).eq("id", ingredient_id);
  } else {
    await supabase.rpc("adjust_ingredient_stock", { p_id: ingredient_id, p_delta: delta });
  }

  // Update ingredient cost if it changed
  if (newCostPerUnit != null && newCostPerUnit !== currentCost) {
    await supabase.from("ingredients").update({ cost_per_unit: newCostPerUnit }).eq("id", ingredient_id);
  }

  return NextResponse.json(adj, { status: 201 });
}
