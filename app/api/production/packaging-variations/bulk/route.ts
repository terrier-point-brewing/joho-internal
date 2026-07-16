import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PACKAGING_VARIATION_SELECT,
  validateFormat,
  computeTotalVolumeFlOz,
  isDuplicateCombo,
  type VariationCombo,
} from "@/lib/production/packagingVariations";
import type { PackagingVariationFormat } from "@/app/production/types";

export const dynamic = "force-dynamic";

interface BulkItem {
  container_id: string;
  format: PackagingVariationFormat;
  lid_id: string;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  name: string;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const items: BulkItem[] = Array.isArray(body?.items) ? body.items : [];

  if (items.length === 0) {
    return NextResponse.json({ error: "items must be a non-empty array" }, { status: 400 });
  }

  const containerIds = Array.from(new Set(items.map((i) => i.container_id)));
  const { data: containers, error: containersError } = await supabase
    .from("packaging_items")
    .select("id, type")
    .in("id", containerIds);
  if (containersError) return NextResponse.json({ error: containersError.message }, { status: 500 });

  const hasNonCan = !containers || containers.length !== containerIds.length || containers.some((c) => c.type !== "can");
  if (hasNonCan) {
    return NextResponse.json({ error: "every container_id must reference a packaging_items row of type can" }, { status: 400 });
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("packaging_variations")
    .select("container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id")
    .in("container_id", containerIds);
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  const existing: VariationCombo[] = existingRows ?? [];

  const skipped: { name: string; reason: string }[] = [];
  const toInsert: (BulkItem & { total_volume_fl_oz: number })[] = [];

  for (const item of items) {
    if (!item.container_id || !item.format || !item.lid_id || !item.name) {
      skipped.push({ name: item.name ?? "(unnamed)", reason: "container_id, format, lid_id, and name are required" });
      continue;
    }
    const formatError = validateFormat(item.format, item.paktech_id || null, item.tray_id || null);
    if (formatError) {
      skipped.push({ name: item.name, reason: formatError });
      continue;
    }
    const combo: VariationCombo = {
      container_id: item.container_id,
      format: item.format,
      lid_id: item.lid_id || null,
      paktech_id: item.paktech_id || null,
      tray_id: item.tray_id || null,
      label_id: item.label_id || null,
      partner_id: item.partner_id || null,
    };
    if (isDuplicateCombo(combo, existing)) {
      skipped.push({ name: item.name, reason: "already exists" });
      continue;
    }
    const total_volume_fl_oz = await computeTotalVolumeFlOz(supabase, {
      container_id: item.container_id,
      format: item.format,
      tray_id: item.tray_id || null,
      paktech_id: item.paktech_id || null,
    });
    toInsert.push({ ...item, total_volume_fl_oz });
    existing.push(combo); // guards against duplicate rows within the same batch
  }

  if (toInsert.length === 0) {
    return NextResponse.json({ created: [], skipped });
  }

  const { data: created, error: insertError } = await supabase
    .from("packaging_variations")
    .insert(toInsert.map((item) => ({
      container_id: item.container_id,
      format: item.format,
      lid_id: item.lid_id || null,
      paktech_id: item.paktech_id || null,
      tray_id: item.tray_id || null,
      label_id: item.label_id || null,
      partner_id: item.partner_id || null,
      name: item.name,
      total_volume_fl_oz: item.total_volume_fl_oz,
    })))
    .select(PACKAGING_VARIATION_SELECT);
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  return NextResponse.json({ created: created ?? [], skipped }, { status: 201 });
}
