import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchMappingGrid } from "@/lib/production/mappingGridData";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { fetchColdStorageOnHand } from "@/lib/production/coldStorageOnHand";
import { buildInventoryGrid, type InventorySources } from "@/lib/production/inventoryGrid";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Taproom cold-storage inventory grid. Keg/can on-hand is the cold_storage_inventory
// source of truth; draft (tapped keg fl oz) still comes from Square via sell-through.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const [grid, coldStorage, draftSellThrough, reconResp] = await Promise.all([
      fetchMappingGrid(supabase),
      fetchColdStorageOnHand(supabase),
      fetchSellThrough(supabase, { packaging: "draft" }),
      supabase
        .from("square_inventory_reconciliations")
        .select("recipe_id, base_variation_name, cold_storage_cans, square_cans_before, drift, occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(50),
    ]);

    const draftByLinkId: InventorySources["draftByLinkId"] = new Map(
      draftSellThrough.map((l) => [l.link_id, { currentQty: l.current_qty, currentBbl: l.current_bbl }]),
    );

    const inventory = buildInventoryGrid(grid, { coldStorage, draftByLinkId });
    return NextResponse.json({ ...inventory, reconciliations: reconResp.data ?? [] });
  } catch (err) {
    return apiError(err);
  }
}
