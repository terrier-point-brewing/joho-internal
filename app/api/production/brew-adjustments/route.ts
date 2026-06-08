import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const transfer_id = req.nextUrl.searchParams.get("batch_transfer_id");
  let query = supabase
    .from("brew_inventory_adjustments")
    .select("*")
    .order("created_at", { ascending: false });
  if (transfer_id) query = query.eq("batch_transfer_id", transfer_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { batch_transfer_id, type, quantity: rawQty, note, new_total, initial_qty, product_label, product_type, unit } = body;
  if (!batch_transfer_id || !type) {
    return NextResponse.json({ error: "batch_transfer_id and type required" }, { status: 400 });
  }

  let quantity: number;
  if (type === "inventory_count") {
    // delta = new_total - current stock (current stock = initial_qty + sum of past adjustments)
    const { data: existing } = await supabase
      .from("brew_inventory_adjustments")
      .select("quantity")
      .eq("batch_transfer_id", batch_transfer_id);
    const sumPast = (existing ?? []).reduce((s, r) => s + Number(r.quantity), 0);
    const current = Number(initial_qty ?? 0) + sumPast;
    quantity = Number(new_total) - current;
  } else if (type === "sold" || type === "distributed" || type === "waste") {
    quantity = -Math.abs(Number(rawQty));
  } else {
    quantity = Number(rawQty);
  }

  const { data, error } = await supabase
    .from("brew_inventory_adjustments")
    .insert({
      batch_transfer_id,
      quantity,
      type,
      note:          note          || null,
      product_label: product_label || null,
      product_type:  product_type  || null,
      unit:          unit          || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
