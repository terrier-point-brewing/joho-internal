import { squarePost, squarePostAll } from "./client";
import { dayRangeUtc } from "@/lib/utils/datetime";

interface InventoryCount {
  catalog_object_id: string;
  catalog_object_type: string;
  state: string;
  location_id: string;
  quantity: string;
  calculated_at: string;
}

/**
 * Current on-hand counts (IN_STOCK) for the given catalog variation ids at the
 * configured location. Returns a map of variation_id → quantity.
 */
export async function fetchCurrentCounts(
  variationIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (variationIds.length === 0) return map;

  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) throw new Error("SQUARE_LOCATION_ID not set");

  // Square caps batch-retrieve at 1000 catalog ids per request.
  for (let i = 0; i < variationIds.length; i += 1000) {
    const chunk = variationIds.slice(i, i + 1000);
    const counts = await squarePostAll<InventoryCount>(
      "/inventory/counts/batch-retrieve",
      "counts",
      { catalog_object_ids: chunk, location_ids: [locationId], states: ["IN_STOCK"] },
    );
    for (const c of counts) {
      map.set(c.catalog_object_id, (map.get(c.catalog_object_id) ?? 0) + Number(c.quantity));
    }
  }
  return map;
}

export interface PhysicalCount {
  id: string;
  catalog_object_id: string;
  catalog_object_type: string;
  state: string;
  location_id: string;
  quantity: string;
  occurred_at: string;
  created_at: string;
  team_member_id?: string;
}

interface ChangesResponse {
  changes?: Array<{ type: string; physical_count?: PhysicalCount }>;
  cursor?: string;
  errors?: Array<{ detail: string }>;
}

// Fetch all physical count inventory changes for a date range, paginated.
export async function fetchPhysicalCounts(
  startDate: string,
  endDate: string
): Promise<PhysicalCount[]> {
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) throw new Error("SQUARE_LOCATION_ID not set");

  const { startUtc: updatedAfter, endUtc: updatedBefore } = dayRangeUtc(startDate, endDate);

  const results: PhysicalCount[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      location_ids:   [locationId],
      updated_after:  updatedAfter,
      updated_before: updatedBefore,
      types:          ["PHYSICAL_COUNT"],
      limit:          1000,
    };
    if (cursor) body.cursor = cursor;

    const data = await squarePost<ChangesResponse>("/inventory/changes/batch-retrieve", body);

    if (data.errors?.length) {
      throw new Error(data.errors[0].detail ?? "Inventory API error");
    }

    for (const change of data.changes ?? []) {
      if (change.type === "PHYSICAL_COUNT" && change.physical_count) {
        results.push(change.physical_count);
      }
    }

    cursor = data.cursor;
  } while (cursor);

  return results;
}
