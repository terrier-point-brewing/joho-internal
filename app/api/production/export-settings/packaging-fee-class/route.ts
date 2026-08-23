import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Writes packaging-fee mappings across a volume class, or across one owner's
 * containers within it.
 *
 * The original whole-class write is how the blank containers were mapped, but
 * it is a point-in-time fan-out: a container added afterwards — always a
 * partner-printed can or keg — gets no row, and the export invoice throws on it
 * because findMapping() keys on packaging_item_id exactly. `owner` narrows the
 * write to the blanks or to one partner's printed containers, so a printed run
 * that genuinely bills at its own rate can be priced apart from the blank, and
 * so the fan-out re-covers that owner's containers whenever it is re-saved.
 *
 * `owner` is packaging_items.partner_id — who the container is printed for —
 * NOT invoice_item_mappings.partner_id, which is who the fee is billed to.
 */
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsOperate); } catch (res) { return res as Response; }

  const body = await req.json() as {
    type: "keg" | "can";
    volume_fl_oz: number;
    /** "all" every container in the class · "blank" the unbranded ones · a partner uuid */
    owner?: string | null;
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

  const owner = body.owner ?? "all";
  let query = supabase
    .from("packaging_items")
    .select("id")
    .eq("type", body.type)
    .eq("volume_fl_oz", body.volume_fl_oz);
  if (owner === "blank") query = query.is("partner_id", null);
  else if (owner !== "all") query = query.eq("partner_id", owner);

  const { data: items, error: itemsErr } = await query;

  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json(
      { error: `No packaging_items found for type=${body.type} volume_fl_oz=${body.volume_fl_oz} owner=${owner}` },
      { status: 404 }
    );
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
  }));

  const { error: upsertErr } = await supabase
    .from("invoice_item_mappings")
    .upsert(rows, { onConflict: "service_type,partner_id,packaging_item_id,packaging_format" });

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  return NextResponse.json({ updated: rows.length });
}
