// app/api/taproom/events/[id]/kegs/route.ts
//
// The kegs an event used. Event pours are rung on Square's "Event Pour" item,
// which the draft reconcile never books against a keg, so the kegs an event
// tapped only leave cold storage when someone ships them. This route is the
// taproom manager's version of Export Bay → Ad-Hoc Export → Taproom: the same
// shipment writer, the same ad-hoc taproom rows, stamped with the event so they
// can be listed back here. Gated on the taproom capability, not the export one.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAvailableColdStorageQuantity } from "@/lib/production/coldStorageDepletion";
import { writeColdStorageShipment } from "@/lib/production/shipmentWriter";
import { triggerSquarePush } from "@/lib/production/triggerSquarePush";

export const dynamic = "force-dynamic";

const refPrefix = (eventId: string) => `event:${eventId}:`;

export interface EventKegLine {
  source_ref: string;
  recipe_id: string;
  recipe_name: string;
  variation_id: string;
  variation_name: string;
  quantity: number;
  notes: string | null;
  shipped_at: string;
}

export interface EventKegStock {
  recipe_id: string;
  recipe_name: string;
  variation_id: string;
  variation_name: string;
  quantity_on_hand: number;
}

/** Kegs in cold storage, every recipe, summed across batches. Cans are not offered. */
async function loadKegStock(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>): Promise<EventKegStock[]> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("recipe_id, variation_id, quantity_on_hand, recipes(beer_name), packaging_variations(name, container:packaging_items!packaging_variations_container_id_fkey(type))")
    .not("recipe_id", "is", null)
    .gt("quantity_on_hand", 0);
  if (error) throw new Error(error.message);

  type Row = {
    recipe_id: string; variation_id: string; quantity_on_hand: number;
    recipes: { beer_name: string } | null;
    packaging_variations: { name: string; container: { type: string } | null } | null;
  };
  const grouped = new Map<string, EventKegStock>();
  for (const raw of data ?? []) {
    const row = raw as unknown as Row;
    if (row.packaging_variations?.container?.type !== "keg") continue;
    const key = `${row.recipe_id}|${row.variation_id}`;
    const existing = grouped.get(key);
    if (existing) { existing.quantity_on_hand += Number(row.quantity_on_hand); continue; }
    grouped.set(key, {
      recipe_id: row.recipe_id,
      recipe_name: row.recipes?.beer_name ?? "Unknown recipe",
      variation_id: row.variation_id,
      variation_name: row.packaging_variations?.name ?? "Keg",
      quantity_on_hand: Number(row.quantity_on_hand),
    });
  }
  return [...grouped.values()].sort((a, b) => a.recipe_name.localeCompare(b.recipe_name) || a.variation_name.localeCompare(b.variation_name));
}

/** The rows already shipped for this event, folded back to one line per ship (the writer splits a line across batches). */
async function loadEventLines(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, eventId: string): Promise<EventKegLine[]> {
  const { data, error } = await supabase
    .from("export_transactions")
    .select("source_ref, recipe_id, variation_id, variant_label, quantity, notes, created_at, recipes(beer_name)")
    .like("source_ref", `${refPrefix(eventId)}%`)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  type Row = { source_ref: string; recipe_id: string; variation_id: string; variant_label: string | null; quantity: number; notes: string | null; created_at: string; recipes: { beer_name: string } | null };
  const lines = new Map<string, EventKegLine>();
  for (const raw of data ?? []) {
    const row = raw as unknown as Row;
    const existing = lines.get(row.source_ref);
    if (existing) { existing.quantity += Number(row.quantity); continue; }
    lines.set(row.source_ref, {
      source_ref: row.source_ref,
      recipe_id: row.recipe_id,
      recipe_name: row.recipes?.beer_name ?? "Unknown recipe",
      variation_id: row.variation_id,
      variation_name: row.variant_label ?? "Keg",
      quantity: Number(row.quantity),
      notes: row.notes,
      shipped_at: row.created_at,
    });
  }
  return [...lines.values()];
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: event, error: eventErr } = await supabase.from("events").select("id, event_end, closed_at").eq("id", id).single();
  if (eventErr || !event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  try {
    const [lines, stock] = await Promise.all([loadEventLines(supabase, id), loadKegStock(supabase)]);
    return NextResponse.json({ closed_at: event.closed_at, event_end: event.event_end, lines, stock });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

interface KegLineRequest { recipe_id: string; variation_id: string; quantity: number; notes?: string | null }

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try { session = await requirePermission(CAP.taproomPerformanceOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const body = await req.json().catch(() => null) as { lines?: KegLineRequest[] } | null;
  const lines = (body?.lines ?? []).filter((l) => l && l.recipe_id && l.variation_id);

  if (lines.length === 0) return NextResponse.json({ error: "Add at least one keg." }, { status: 400 });
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) {
      return NextResponse.json({ error: "Each keg line needs a whole number of kegs, at least 1." }, { status: 400 });
    }
  }

  const { data: event, error: eventErr } = await supabase.from("events").select("id, event_name, event_end").eq("id", id).single();
  if (eventErr || !event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  if (new Date(event.event_end).getTime() > Date.now()) {
    return NextResponse.json({ error: "This event has not ended yet. Record its kegs after the end time." }, { status: 422 });
  }

  // Merge duplicate recipe+keg lines so the availability check sees the real total.
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(`${l.recipe_id}|${l.variation_id}`, (wanted.get(`${l.recipe_id}|${l.variation_id}`) ?? 0) + l.quantity);

  // Check every line before shipping any, so a short beer stops the whole
  // close-out instead of leaving it half recorded.
  const stock = await loadKegStock(supabase).catch(() => null);
  for (const [key, qty] of wanted) {
    const [recipeId, variationId] = key.split("|");
    let available: number;
    try {
      available = await getAvailableColdStorageQuantity(supabase, { recipeId, variationId });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }
    if (qty > available) {
      const name = stock?.find((s) => s.recipe_id === recipeId && s.variation_id === variationId);
      const label = name ? `${name.recipe_name} (${name.variation_name})` : "That beer";
      return NextResponse.json({ error: `${label}: only ${available} in cold storage, ${qty} requested.` }, { status: 422 });
    }
  }

  const shipped: string[] = [];
  for (const l of lines) {
    const sourceRef = `${refPrefix(id)}${crypto.randomUUID()}`;
    try {
      await writeColdStorageShipment(supabase, {
        channel: "taproom",
        recipeId: l.recipe_id,
        variationId: l.variation_id,
        quantity: l.quantity,
        recipientName: event.event_name,
        allocationId: null,
        sourceRef,
        notes: l.notes?.trim() || null,
        adHoc: true,
      });
      shipped.push(sourceRef);
    } catch (e) {
      // Everything already written stays written — it is real beer that left.
      return NextResponse.json({
        error: `${e instanceof Error ? e.message : "Unknown error"} (${shipped.length} of ${lines.length} kegs lines were recorded before this; reopen the event to see them.)`,
        shipped,
      }, { status: 500 });
    }
  }

  const { error: closeErr } = await supabase
    .from("events")
    .update({ closed_at: new Date().toISOString(), closed_by: session.user.id })
    .eq("id", id)
    .is("closed_at", null);
  if (closeErr) return NextResponse.json({ error: closeErr.message, shipped }, { status: 500 });

  // The push decides for itself whether Square still owes a deduction for this stock.
  await triggerSquarePush(supabase, [...new Set(lines.map((l) => l.recipe_id))], "event close-out");

  return NextResponse.json({ shipped }, { status: 201 });
}
