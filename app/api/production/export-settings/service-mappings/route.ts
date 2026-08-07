import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SERVICE_TYPES = ["packaging_fee", "keg_cleaning", "forklift", "ingredient_deposit", "distribution_discount", "wholesale_discount", "packaging_material"] as const;
const DISCOUNT_TYPES = ["distribution_discount", "wholesale_discount"] as const;
type ServiceType = typeof SERVICE_TYPES[number];

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsRead); } catch (res) { return res as Response; }

  const { searchParams } = new URL(req.url);
  const serviceType = searchParams.get("service_type");
  const partnerId = searchParams.get("partner_id");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("invoice_item_mappings")
    .select("id, service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
    .order("service_type")
    .order("display_name");

  if (serviceType) query = query.eq("service_type", serviceType);
  if (partnerId) query = query.eq("partner_id", partnerId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsManage); } catch (res) { return res as Response; }

  const body = await req.json() as {
    id?: string;
    service_type: ServiceType;
    partner_id?: string | null;
    packaging_item_id?: string | null;
    packaging_format?: "case" | "loose" | null;
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
  if (body.service_type === "packaging_fee" && body.packaging_format && !["case", "loose"].includes(body.packaging_format)) {
    return NextResponse.json({ error: "packaging_format must be 'case' or 'loose'" }, { status: 400 });
  }

  const row = {
    service_type: body.service_type,
    partner_id: body.partner_id ?? null,
    packaging_item_id: body.service_type === "packaging_fee" ? (body.packaging_item_id ?? null) : null,
    packaging_format: body.service_type === "packaging_fee" ? (body.packaging_format ?? null) : null,
    square_catalog_item_id: DISCOUNT_TYPES.includes(body.service_type as typeof DISCOUNT_TYPES[number]) ? null : (body.square_catalog_item_id ?? null),
    square_catalog_variation_id: DISCOUNT_TYPES.includes(body.service_type as typeof DISCOUNT_TYPES[number]) ? null : (body.square_catalog_variation_id ?? null),
    square_catalog_discount_id: DISCOUNT_TYPES.includes(body.service_type as typeof DISCOUNT_TYPES[number]) ? (body.square_catalog_discount_id ?? null) : null,
    display_name: body.display_name,
  };

  const supabase = createSupabaseAdminClient();
  const { data, error } = body.id
    ? await supabase
        .from("invoice_item_mappings")
        .update(row)
        .eq("id", body.id)
        .select("id, service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single()
    : await supabase
        .from("invoice_item_mappings")
        .upsert(row, { onConflict: "service_type,partner_id,packaging_item_id,packaging_format" })
        .select("id, service_type, partner_id, packaging_item_id, packaging_format, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
