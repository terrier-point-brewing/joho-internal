import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCompletedOrdersChunked } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";
import {
  findOrphanPours,
  clusterOrphanPours,
  type EventWindow,
  type OrphanCluster,
} from "@/lib/taproom/unallocatedEventPours";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

export interface UnallocatedPoursResponse {
  /** Brewery-local day range scanned, inclusive. */
  from: string;
  to: string;
  clusters: OrphanCluster[];
}

const DEFAULT_DAYS = 60;
const MAX_DAYS = 180;

/**
 * Event Pours rung in the last `days` (default 60, max 180) whose order closed
 * outside every event's window. Reads the same Square orders and the same
 * "Event Pour" catalog test as /api/taproom/events/[id]/pours, so a pour shows
 * up here exactly when no event on the tab would count it.
 */
export async function GET(req: NextRequest) {
  const daysParam = Number(req.nextUrl.searchParams.get("days") ?? DEFAULT_DAYS);
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(Math.trunc(daysParam), 1), MAX_DAYS) : DEFAULT_DAYS;

  const supabase = await createSupabaseServerClient();
  const tz = await getBreweryTimezone();
  const to = todayLocalDate(tz);
  const from = addDaysStr(to, -(days - 1));

  // Every event, not just those in range: an event whose window starts before
  // `from` can still cover a pour inside it.
  const [{ data: events, error }, catalogItems, orders] = await Promise.all([
    supabase.from("events").select("id, event_name, event_start, event_end"),
    fetchCatalogItems() as Promise<CatalogItem[]>,
    fetchCompletedOrdersChunked(from, to),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const variationNames = new Map<string, string>();
  for (const item of catalogItems) {
    if (!item.item_data.name.toLowerCase().includes("event pour")) continue;
    for (const v of item.item_data.variations ?? []) {
      variationNames.set(v.id, v.item_variation_data.name ?? item.item_data.name);
    }
  }

  const windows = (events ?? []) as EventWindow[];
  const orphans = findOrphanPours(orders, variationNames, windows);
  const clusters = clusterOrphanPours(orphans, windows, tz);

  const body: UnallocatedPoursResponse = { from, to, clusters };
  return NextResponse.json(body);
}
