import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SERVICE_TYPES = ["packaging_fee", "keg_cleaning", "forklift", "bulk_discount"] as const;
type ServiceType = typeof SERVICE_TYPES[number];

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const { searchParams } = new URL(req.url);
  const serviceType = searchParams.get("service_type");
  const partnerId = searchParams.get("partner_id");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("export_service_mappings")
    .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
    .order("service_type")
    .order("display_name");

  if (serviceType) query = query.eq("service_type", serviceType);
  if (partnerId) query = query.eq("partner_id", partnerId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function PUT(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    id?: string;
    service_type: ServiceType;
    partner_id?: string | null;
    packaging_item_id?: string | null;
    square_catalog_item_id?: string | null;
    square_catalog_variation_id?: string | null;
    square_catalog_discount_id?: string | null;
    display_name: string;
  };

  if (!SERVICE_TYPES.includes(body.service_type)) {
    return NextResponse.json({ error: "Invalid service_type" }, { status: 400 });
  }
  if (!body.display_name) {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
  }

  const row = {
    service_type: body.service_type,
    partner_id: body.partner_id ?? null,
    packaging_item_id: body.service_type === "packaging_fee" ? (body.packaging_item_id ?? null) : null,
    square_catalog_item_id: body.service_type === "bulk_discount" ? null : (body.square_catalog_item_id ?? null),
    square_catalog_variation_id: body.service_type === "bulk_discount" ? null : (body.square_catalog_variation_id ?? null),
    square_catalog_discount_id: body.service_type === "bulk_discount" ? (body.square_catalog_discount_id ?? null) : null,
    display_name: body.display_name,
    updated_at: new Date().toISOString(),
  };

  const supabase = createSupabaseAdminClient();
  const { data, error } = body.id
    ? await supabase
        .from("export_service_mappings")
        .update(row)
        .eq("id", body.id)
        .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single()
    : await supabase
        .from("export_service_mappings")
        .upsert(row, { onConflict: "service_type,partner_id,packaging_item_id" })
        .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
