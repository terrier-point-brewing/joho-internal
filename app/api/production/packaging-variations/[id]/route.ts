import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PACKAGING_VARIATION_SELECT, validateFormat, validateBreaksInto, computeTotalVolumeFlOz } from "@/lib/production/packagingVariations";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();
  const { container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id, name, is_active, breaks_into_variation_id } = body;

  if (!container_id || !format || !name) {
    return NextResponse.json({ error: "container_id, format, and name are required" }, { status: 400 });
  }

  const formatError = validateFormat(format, paktech_id || null, tray_id || null);
  if (formatError) return NextResponse.json({ error: formatError }, { status: 400 });

  if (breaks_into_variation_id && breaks_into_variation_id === id) {
    return NextResponse.json({ error: "breaks_into_variation_id cannot reference itself" }, { status: 400 });
  }

  let breaksIntoTarget = null;
  if (breaks_into_variation_id) {
    const { data } = await supabase
      .from("packaging_variations")
      .select("format, container_id, lid_id, label_id, partner_id")
      .eq("id", breaks_into_variation_id)
      .single();
    breaksIntoTarget = data ?? null;
  }
  const breaksIntoError = validateBreaksInto(format, breaks_into_variation_id || null, breaksIntoTarget, {
    container_id, lid_id: lid_id || null, label_id: label_id || null, partner_id: partner_id || null,
  });
  if (breaksIntoError) return NextResponse.json({ error: breaksIntoError }, { status: 400 });

  const { data: container } = await supabase
    .from("packaging_items")
    .select("type")
    .eq("id", container_id)
    .single();
  if (!container || (container.type !== "keg" && container.type !== "can")) {
    return NextResponse.json({ error: "container_id must reference a packaging_items row of type keg or can" }, { status: 400 });
  }

  if (container.type === "can" && !lid_id) {
    return NextResponse.json({ error: "lid_id is required for can packaging variations" }, { status: 400 });
  }

  const total_volume_fl_oz = await computeTotalVolumeFlOz(supabase, {
    container_id, format, tray_id: tray_id || null, paktech_id: paktech_id || null,
  });

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
      breaks_into_variation_id: breaks_into_variation_id || null,
      name,
      is_active: is_active ?? true,
      total_volume_fl_oz,
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
