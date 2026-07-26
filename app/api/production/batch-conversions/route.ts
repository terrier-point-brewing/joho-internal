import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const BATCH_CONVERSION_SELECT = `
  id, source_batch_id, target_batch_id, source_equipment_id,
  volume_bbl, planned_date, converted_at, notes, created_at,
  target_batch:brew_batches!target_batch_id(id, beer_name, batch_number),
  source_batch:brew_batches!source_batch_id(id, beer_name, batch_number)
`.trim();

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.brewingRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { searchParams } = new URL(req.url);
  const sourceBatchId  = searchParams.get("source_batch_id");
  const targetBatchId  = searchParams.get("target_batch_id");
  const convertedAtNull = searchParams.get("converted_at") === "null";

  let query = supabase
    .from("batch_conversions")
    .select(BATCH_CONVERSION_SELECT)
    .order("created_at", { ascending: false });

  if (sourceBatchId)  query = query.eq("source_batch_id", sourceBatchId);
  if (targetBatchId)  query = query.eq("target_batch_id", targetBatchId);
  if (convertedAtNull) query = query.is("converted_at", null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const {
    source_batch_id,
    target_batch_id,
    source_equipment_id,
    volume_bbl,
    planned_date,
    notes,
  } = body as {
    source_batch_id:     string;
    target_batch_id:     string;
    source_equipment_id: string | null;
    volume_bbl:          number;
    planned_date:        string | null;
    notes:               string | null;
  };

  if (!source_batch_id || !target_batch_id || !volume_bbl) {
    return NextResponse.json({ error: "source_batch_id, target_batch_id, and volume_bbl are required." }, { status: 422 });
  }
  if (source_batch_id === target_batch_id) {
    return NextResponse.json({ error: "Source and target batch must be different." }, { status: 422 });
  }

  const { data, error } = await supabase
    .from("batch_conversions")
    .insert({
      source_batch_id,
      target_batch_id,
      source_equipment_id: source_equipment_id ?? null,
      volume_bbl,
      planned_date:        planned_date ?? null,
      notes:               notes ?? null,
    })
    .select(BATCH_CONVERSION_SELECT)
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A conversion between these two batches already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // PATCH target batch to set converted_from_batch_id if not already set
  await supabase
    .from("brew_batches")
    .update({ converted_from_batch_id: source_batch_id })
    .eq("id", target_batch_id)
    .is("converted_from_batch_id", null);

  return NextResponse.json(data, { status: 201 });
}
