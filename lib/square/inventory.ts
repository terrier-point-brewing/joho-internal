import { squarePost } from "./client";
import type { CatalogObject } from "@/types/square";

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

  const updatedAfter  = new Date(startDate + "T00:00:00").toISOString();
  const updatedBefore = new Date(endDate   + "T23:59:59").toISOString();

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
