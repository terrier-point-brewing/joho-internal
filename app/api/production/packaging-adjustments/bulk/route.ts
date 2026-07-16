import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";

export const dynamic = "force-dynamic";

interface BulkLine {
  packaging_item_id: string;
  quantity: number;
  purchase_cost: number;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const lines: BulkLine[] = Array.isArray(body.lines) ? body.lines : [];
  const freightTotal = Number(body.freight_total ?? 0);

  if (lines.length === 0)
    return NextResponse.json({ error: "At least one line is required" }, { status: 400 });
  if (!(freightTotal >= 0))
    return NextResponse.json({ error: "freight_total must be >= 0" }, { status: 400 });

  const ids = lines.map((l) => l.packaging_item_id);
  if (new Set(ids).size !== ids.length)
    return NextResponse.json({ error: "Duplicate packaging_item_id in lines" }, { status: 400 });

  for (const l of lines) {
    if (!(Number(l.quantity) > 0))
      return NextResponse.json({ error: `quantity must be > 0 for packaging item ${l.packaging_item_id}` }, { status: 400 });
    if (!(Number(l.purchase_cost) > 0))
      return NextResponse.json({ error: `purchase_cost must be > 0 for packaging item ${l.packaging_item_id}` }, { status: 400 });
  }

  const { data: itemsData, error: fetchErr } = await supabase
    .from("packaging_items")
    .select("id, stock_quantity, unit_cost")
    .in("id", ids);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const byId = new Map((itemsData ?? []).map((i) => [i.id, i]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return NextResponse.json({ error: `Packaging item(s) not found: ${missing.join(", ")}` }, { status: 404 });

  // packaging_items has no `unit` column, so every line gets an unmatchable unit —
  // allocateFreightByWeight's fallback then splits freight by raw quantity.
  const shippingByLine = allocateFreightByWeight(
    lines.map((l) => ({ unit: "", quantity: Number(l.quantity) })),
    freightTotal
  );

  const results: { packaging_item_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[] = [];
  const errors: { packaging_item_id: string; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const current = byId.get(line.packaging_item_id)!;
    const quantity = Number(line.quantity);
    const purchaseCost = Number(line.purchase_cost);
    const shippingCost = shippingByLine[i];

    const { landedCostPerUnit, newStock, newCostPerUnit } = computeReceivedAdjustment({
      currentStock: Number(current.stock_quantity ?? 0),
      currentCostPerUnit: current.unit_cost != null ? Number(current.unit_cost) : null,
      quantity,
      purchaseCost,
      shippingCost,
    });

    const { error: adjErr } = await supabase.from("packaging_stock_adjustments").insert({
      packaging_item_id: line.packaging_item_id,
      type: "received",
      quantity,
      note: null,
      cost_per_unit: purchaseCost,
      shipping_cost: shippingCost > 0 ? shippingCost : null,
      total_value_change: quantity * landedCostPerUnit,
    });
    if (adjErr) { errors.push({ packaging_item_id: line.packaging_item_id, error: adjErr.message }); continue; }

    const { error: updErr } = await supabase
      .from("packaging_items")
      .update({ stock_quantity: newStock, unit_cost: newCostPerUnit })
      .eq("id", line.packaging_item_id);
    if (updErr) { errors.push({ packaging_item_id: line.packaging_item_id, error: updErr.message }); continue; }

    results.push({
      packaging_item_id: line.packaging_item_id,
      new_stock: newStock,
      new_cost_per_unit: newCostPerUnit,
      shipping_cost: shippingCost,
    });
  }

  return NextResponse.json({ results, errors }, { status: errors.length === 0 ? 201 : 207 });
}
