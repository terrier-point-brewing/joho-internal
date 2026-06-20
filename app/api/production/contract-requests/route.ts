import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("commitments")
    .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, volume_fl_oz)")
    .order("created_at", { ascending: false });
  const channel = req.nextUrl.searchParams.get("channel");
  if (channel) query = query.eq("channel", channel);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json(data);

  // Sum committed BBL (batch volume x allocated %) per commitment across all batches,
  // so the UI can hide commitments that have already been fully allocated against.
  const ids = data.map((c) => c.id);
  const { data: allocs } = await supabase
    .from("batch_allocations")
    .select("contract_request_id, percentage, brew_batches(volume_bbl)")
    .in("contract_request_id", ids);

  const committedById: Record<string, number> = {};
  for (const a of allocs ?? []) {
    if (!a.contract_request_id) continue;
    const vol = Number((a.brew_batches as { volume_bbl?: number } | null)?.volume_bbl ?? 0);
    committedById[a.contract_request_id] = (committedById[a.contract_request_id] ?? 0) + (Number(a.percentage) / 100) * vol;
  }

  const enriched = data.map((c) => ({ ...c, committed_allocated_bbl: committedById[c.id] ?? 0 }));
  return NextResponse.json(enriched);
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const b = await req.json();
  const { beer_style, partner_id, volume_bbl } = b;
  if (!beer_style || volume_bbl == null) {
    return NextResponse.json({ error: "beer_style and volume_bbl are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("commitments")
    .insert({
      recipe_id: b.recipe_id || null,
      beer_style,
      partner_id: partner_id || null,
      volume_bbl,
      desired_delivery_date: b.desired_delivery_date || null,
      status: b.status || "open",
      notes: b.notes || null,
      packaging_item_id: b.packaging_item_id || null,
      packaging_qty: b.packaging_qty || null,
      channel: b.channel || "contract_brewing",
      cadence: b.cadence || "one_time",
      recurrence: b.recurrence || null,
      start_date: b.start_date || null,
      end_date: b.end_date || null,
      received_on: b.received_on || null,
      locked_on: b.locked_on || null,
      last_edited_on: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const b = await req.json();
  const allowed = ["recipe_id", "beer_style", "status", "notes", "volume_bbl", "desired_delivery_date", "partner_id", "packaging_item_id", "packaging_qty", "channel", "cadence", "recurrence", "start_date", "end_date", "received_on", "locked_on"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in b) patch[k] = b[k];
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  patch.last_edited_on = new Date().toISOString();
  const { data, error } = await supabase.from("commitments").update(patch).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("commitments").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
