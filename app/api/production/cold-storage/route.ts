import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/cold-storage
// Per-batch finished-goods lots currently held in cold storage, read from
// cold_storage_inventory — the source of truth for on-hand kegs/cans (it
// tracks packaging, break-downs, depletion and reconciliation, none of which
// are reflected by raw batch_transfers). The floorplan cold-storage tile lists
// one row per (batch, packaging variation) with the current quantity on hand.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select(
      "id, batch_id, variation_id, quantity_on_hand, " +
      "brew_batches(beer_name, batch_number), " +
      "packaging_variations(name, container:packaging_items!packaging_variations_container_id_fkey(type))",
    )
    .gt("quantity_on_hand", 0);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type BatchRow = { beer_name: string | null; batch_number: number | null } | null;
  type PVRow = { name: string | null; container?: { type: string } | null } | null;

  const lots = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
    const batch = row.brew_batches as unknown as BatchRow;
    const pv = row.packaging_variations as unknown as PVRow;
    return {
      id: row.id as string,
      batch_id: row.batch_id as string,
      variation_id: row.variation_id as string,
      quantity_on_hand: Number(row.quantity_on_hand),
      beer_name: batch?.beer_name ?? null,
      batch_number: batch?.batch_number ?? null,
      variation_name: pv?.name ?? null,
      container_type: pv?.container?.type ?? null,
    };
  });

  return NextResponse.json(lots);
}
