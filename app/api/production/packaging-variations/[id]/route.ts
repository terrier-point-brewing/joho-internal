import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PACKAGING_VARIATION_SELECT, validateFormat } from "@/lib/production/packagingVariations";

export const dynamic = "force-dynamic";

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

  const { data: container } = await supabase
    .from("packaging_items")
    .select("type")
    .eq("id", container_id)
    .single();
  if (!container || (container.type !== "keg" && container.type !== "can")) {
    return NextResponse.json({ error: "container_id must reference a packaging_items row of type keg or can" }, { status: 400 });
  }

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
    .select(PACKAGING_VARIATION_SELECT)
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
