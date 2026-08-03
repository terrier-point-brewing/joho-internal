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
    // No longer reads square_inventory_reconciliations. That feed reported every
    // attempted correction as an applied one, so a SKU whose writes had never
    // landed showed as freshly reconciled — 1,040 rows of it for a single beer,
    // which also swamped the 50-row window. Square-vs-cold-storage now lives in
    // the drift view (/api/taproom/inventory/drift), measured live.
    const [grid, coldStorage, draftSellThrough] = await Promise.all([
      fetchMappingGrid(supabase),
      fetchColdStorageOnHand(supabase),
      fetchSellThrough(supabase, { packaging: "draft" }),
    ]);

    const draftByLinkId: InventorySources["draftByLinkId"] = new Map(
      draftSellThrough.map((l) => [l.link_id, { currentQty: l.current_qty, currentBbl: l.current_bbl }]),
    );

    return NextResponse.json(buildInventoryGrid(grid, { coldStorage, draftByLinkId }));
  } catch (err) {
    return apiError(err);
  }
}
