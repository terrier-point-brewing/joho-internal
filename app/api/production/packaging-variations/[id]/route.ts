import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT = `
  *,
  container:packaging_items!packaging_variations_container_id_fkey(id, name, type, volume_fl_oz),
  lid:packaging_items!packaging_variations_lid_id_fkey(id, name),
  paktech:packaging_items!packaging_variations_paktech_id_fkey(id, name),
  tray:packaging_items!packaging_variations_tray_id_fkey(id, name),
  label:packaging_items!packaging_variations_label_id_fkey(id, name),
  contract_brewing_partners(company_name)
`;

function validateFormat(format: string, paktech_id: string | null, tray_id: string | null): string | null {
  if (format === "4-pack" || format === "6-pack") {
    if (!paktech_id) return `format "${format}" requires paktech_id`;
    if (tray_id) return `format "${format}" must not have tray_id`;
  }
  if (format === "case") {
    if (!tray_id) return `format "case" requires tray_id`;
    if (paktech_id) return `format "case" must not have paktech_id`;
  }
  if (format === "loose" && (paktech_id || tray_id)) {
    return `format "loose" must not have paktech_id or tray_id`;
  }
  return null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();
  const { container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id, name, is_active } = body;

  if (!container_id || !format || !name) {
    return NextResponse.json({ error: "container_id, format, and name are required" }, { status: 400 });
  }

  const formatError = validateFormat(format, paktech_id || null, tray_id || null);
  if (formatError) return NextResponse.json({ error: formatError }, { status: 400 });

  const { data, error } = await supabase
    .from("packaging_variations")
    .update({
      container_id,
      format,
      lid_id: lid_id || null,
      paktech_id: paktech_id || null,
      tray_id: tray_id || null,
      label_id: label_id || null,
      partner_id: partner_id || null,
      name,
      is_active: is_active ?? true,
    })
    .eq("id", id)
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const { error } = await supabase.from("packaging_variations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
