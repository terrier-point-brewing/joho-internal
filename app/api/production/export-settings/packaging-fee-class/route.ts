import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    type: "keg" | "can";
    volume_fl_oz: number;
    format: "case" | "loose" | null;
    partner_id: string | null;
    square_catalog_item_id: string;
    square_catalog_variation_id: string;
    display_name: string;
  };

  if (!body.type || body.volume_fl_oz == null) {
    return NextResponse.json({ error: "type and volume_fl_oz are required" }, { status: 400 });
  }
  if (!body.square_catalog_item_id || !body.square_catalog_variation_id) {
    return NextResponse.json({ error: "square_catalog_item_id and square_catalog_variation_id are required" }, { status: 400 });
  }
  if (body.type === "can" && !body.format) {
    return NextResponse.json({ error: "format ('case' or 'loose') is required for can items" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Find all packaging_items in this volume class
  const { data: items, error: itemsErr } = await supabase
    .from("packaging_items")
    .select("id")
    .eq("type", body.type)
    .eq("volume_fl_oz", body.volume_fl_oz);

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json({ error: `No packaging_items found for type=${body.type} volume_fl_oz=${body.volume_fl_oz}` }, { status: 404 });
  }

  const rows = items.map((item) => ({
    service_type: "packaging_fee" as const,
    partner_id: body.partner_id ?? null,
    packaging_item_id: item.id,
    packaging_format: body.format ?? null,
    square_catalog_item_id: body.square_catalog_item_id,
    square_catalog_variation_id: body.square_catalog_variation_id,
    square_catalog_discount_id: null,
    display_name: body.display_name,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertErr } = await supabase
    .from("invoice_item_mappings")
    .upsert(rows, { onConflict: "service_type,partner_id,packaging_item_id,packaging_format" });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  return NextResponse.json({ updated: rows.length });
}
