import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchMappingGrid } from "@/lib/production/mappingGridData";
import { fetchSellThrough } from "@/lib/square/sell-through";
import { buildInventoryGrid, type LinkInventory } from "@/lib/production/inventoryGrid";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Taproom cold-storage inventory grid: the Square-mapping grid structure enriched
// with on-hand quantities from sell-through, plus row/column/grand BBL totals.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const [grid, sellThrough] = await Promise.all([
      fetchMappingGrid(supabase),
      fetchSellThrough(supabase),
    ]);

    const inventoryByLinkId = new Map<string, LinkInventory>(
      sellThrough.map((l) => [
        l.link_id,
        { currentQty: l.current_qty, currentBbl: l.current_bbl, packaging: l.packaging },
      ]),
    );

    return NextResponse.json(buildInventoryGrid(grid, inventoryByLinkId));
  } catch (err) {
    return apiError(err);
  }
}
