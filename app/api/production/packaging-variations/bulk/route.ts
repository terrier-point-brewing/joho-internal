import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PACKAGING_VARIATION_SELECT,
  validateFormat,
  validateBreaksInto,
  computeTotalVolumeFlOz,
  isDuplicateCombo,
  type VariationCombo,
} from "@/lib/production/packagingVariations";
import type { PackagingVariationFormat } from "@/app/production/types";

export const dynamic = "force-dynamic";

// A "case" row's breaks_into_variation_id may reference a 4-pack/6-pack sibling
// created earlier in this SAME batch (which has no real id yet at request time)
// via this sentinel instead of a real uuid — resolved once that sibling is
// actually inserted, in phase 2 below.
const BATCH_SIBLING_PREFIX = "batch:";

interface BulkItem {
  container_id: string;
  format: PackagingVariationFormat;
  lid_id: string;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  breaks_into_variation_id: string | null;
  name: string;
}

type PreppedItem = BulkItem & { total_volume_fl_oz: number };

interface BreaksIntoTarget {
  format: string;
  container_id: string;
  lid_id: string | null;
  label_id: string | null;
  partner_id: string | null;
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
    .select("id, container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id")
    .in("container_id", containerIds);
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  const existing: VariationCombo[] = existingRows ?? [];
  const existingById = new Map<string, BreaksIntoTarget>((existingRows ?? []).map((r) => [r.id, r]));

  const skipped: { name: string; reason: string }[] = [];

  async function validateAndPrep(item: BulkItem): Promise<PreppedItem | null> {
    if (!item.container_id || !item.format || !item.lid_id || !item.name) {
      skipped.push({ name: item.name ?? "(unnamed)", reason: "container_id, format, lid_id, and name are required" });
      return null;
    }
    const formatError = validateFormat(item.format, item.paktech_id || null, item.tray_id || null);
    if (formatError) {
      skipped.push({ name: item.name, reason: formatError });
      return null;
    }
    if (item.format !== "case") {
      // Non-case rows never carry breaks_into_variation_id — validated here
      // (rather than skipped silently) so a misbehaving client is reported,
      // matching the single-item route's validateBreaksInto contract.
      const breaksIntoError = validateBreaksInto(item.format, item.breaks_into_variation_id || null, null, {
        container_id: item.container_id, lid_id: item.lid_id || null, label_id: item.label_id || null, partner_id: item.partner_id || null,
      });
      if (breaksIntoError) {
        skipped.push({ name: item.name, reason: breaksIntoError });
        return null;
      }
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
      return null;
    }
    const total_volume_fl_oz = await computeTotalVolumeFlOz(supabase, {
      container_id: item.container_id,
      format: item.format,
      tray_id: item.tray_id || null,
      paktech_id: item.paktech_id || null,
    });
    existing.push(combo); // guards against duplicate rows within the same batch
    return { ...item, total_volume_fl_oz };
  }

  // Phase 1: every non-"case" row. A case may depend on a 4-pack/6-pack
  // sibling created in this same batch, which doesn't have a real id until
  // its own insert completes — so case rows are deferred to phase 2.
  const caseItems = items.filter((i) => i.format === "case");
  const nonCaseItems = items.filter((i) => i.format !== "case");

  const nonCaseToInsert: PreppedItem[] = [];
  for (const item of nonCaseItems) {
    const prepped = await validateAndPrep(item);
    if (prepped) nonCaseToInsert.push(prepped);
  }

  let insertedNonCase: Array<Record<string, unknown> & { id: string; format: string; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null }> = [];
  if (nonCaseToInsert.length > 0) {
    const { data, error } = await supabase
      .from("packaging_variations")
      .insert(nonCaseToInsert.map((item) => ({
        container_id: item.container_id,
        format: item.format,
        lid_id: item.lid_id || null,
        paktech_id: item.paktech_id || null,
        tray_id: item.tray_id || null,
        label_id: item.label_id || null,
        partner_id: item.partner_id || null,
        breaks_into_variation_id: null,
        name: item.name,
        total_volume_fl_oz: item.total_volume_fl_oz,
      })))
      .select(PACKAGING_VARIATION_SELECT);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    insertedNonCase = data ?? [];
  }

  // "batch:4-pack" / "batch:6-pack" -> the row just inserted for that format in
  // THIS batch, if any (it may have been skipped as a duplicate/invalid, in
  // which case the sentinel below fails to resolve).
  const batchSiblingByFormat = new Map(insertedNonCase.map((r) => [r.format, r]));

  const caseToInsert: { item: PreppedItem; breaksIntoId: string | null }[] = [];
  for (const item of caseItems) {
    const prepped = await validateAndPrep(item);
    if (!prepped) continue;

    const raw = item.breaks_into_variation_id;
    let breaksIntoId: string | null = null;
    let target: BreaksIntoTarget | null = null;

    if (raw && raw.startsWith(BATCH_SIBLING_PREFIX)) {
      const siblingFormat = raw.slice(BATCH_SIBLING_PREFIX.length);
      const sibling = batchSiblingByFormat.get(siblingFormat);
      if (!sibling) {
        skipped.push({ name: item.name, reason: `breaks_into_variation_id references this batch's ${siblingFormat}, which was not created` });
        continue;
      }
      breaksIntoId = sibling.id;
      target = { format: sibling.format, container_id: sibling.container_id, lid_id: sibling.lid_id, label_id: sibling.label_id, partner_id: sibling.partner_id };
    } else if (raw) {
      breaksIntoId = raw;
      target = existingById.get(raw) ?? null;
    }

    const breaksIntoError = validateBreaksInto(item.format, breaksIntoId, target, {
      container_id: item.container_id, lid_id: item.lid_id || null, label_id: item.label_id || null, partner_id: item.partner_id || null,
    });
    if (breaksIntoError) {
      skipped.push({ name: item.name, reason: breaksIntoError });
      continue;
    }

    caseToInsert.push({ item: prepped, breaksIntoId });
  }

  let insertedCase: Array<Record<string, unknown>> = [];
  if (caseToInsert.length > 0) {
    const { data, error } = await supabase
      .from("packaging_variations")
      .insert(caseToInsert.map(({ item, breaksIntoId }) => ({
        container_id: item.container_id,
        format: item.format,
        lid_id: item.lid_id || null,
        paktech_id: item.paktech_id || null,
        tray_id: item.tray_id || null,
        label_id: item.label_id || null,
        partner_id: item.partner_id || null,
        breaks_into_variation_id: breaksIntoId,
        name: item.name,
        total_volume_fl_oz: item.total_volume_fl_oz,
      })))
      .select(PACKAGING_VARIATION_SELECT);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    insertedCase = data ?? [];
  }

  const created = [...insertedNonCase, ...insertedCase];
  return NextResponse.json({ created, skipped }, { status: created.length > 0 ? 201 : 200 });
}
