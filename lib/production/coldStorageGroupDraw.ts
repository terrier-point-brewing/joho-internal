// lib/production/coldStorageGroupDraw.ts
//
// Splits one sale across the packaging variations behind a fungible Square SKU,
// oldest cold-storage lot first.
//
// This sits ABOVE writeColdStorageShipment rather than inside it, on purpose.
// That writer resolves volume, units-per-package, container and packaging-loss
// FROM the variation, and stamps them onto the export row it writes. Teaching it
// to span variations would mean one row averaging two different cans. Instead
// the draw is planned here and the writer is called once per variation with its
// own slice, so every export row keeps naming the can that actually left and the
// excise, materials and shipment ledgers stay exact.
//
// The order is the age of the stock, not a stored rank — see the
// square_fungible_skus migration. Within a single variation
// depleteColdStorageInventory already drains oldest-row-first, so a slice handed
// to the writer is drawn from exactly the lots this planner counted.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

/** One cold-storage lot, as the planner needs it. */
export interface DrawLot {
  variationId: string;
  quantityOnHand: number;
  createdAt: string;
}

/** How much of the sale one variation covers. */
export interface DrawSlice {
  variationId: string;
  quantity: number;
}

export interface GroupDraw {
  slices: DrawSlice[];
  /** Requested quantity no lot in the group could cover. */
  shortfall: number;
}

const EPS = 1e-4;

/**
 * Allocate `quantity` across lots oldest-first, collapsing to one slice per
 * variation in the order that variation was FIRST reached.
 *
 * Collapsing matters: a group whose lots interleave by age (printed, labeled,
 * printed) would otherwise produce three writer calls and three export rows for
 * one sale. The lots themselves are still drained in age order — that happens
 * inside depleteColdStorageInventory — so collapsing changes the number of rows,
 * never which beer is taken.
 *
 * Pure. Exported for unit testing.
 */
export function planGroupDraw(lots: DrawLot[], quantity: number): GroupDraw {
  const ordered = [...lots].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const byVariation = new Map<string, number>();
  let left = quantity;
  for (const lot of ordered) {
    if (left <= EPS) break;
    const available = Number(lot.quantityOnHand);
    if (!(available > 0)) continue;
    const take = Math.min(available, left);
    byVariation.set(lot.variationId, (byVariation.get(lot.variationId) ?? 0) + take);
    left -= take;
  }

  return {
    slices: [...byVariation.entries()].map(([variationId, qty]) => ({
      variationId,
      // Float dust from summing several lots would otherwise reach the writer as
      // a quantity fractionally above what depletion can actually cover.
      quantity: Math.round(qty * 1e6) / 1e6,
    })),
    shortfall: left > EPS ? Math.round(left * 1e6) / 1e6 : 0,
  };
}

/**
 * Read the group's lots and plan the draw. `variationIds` is the whole declared
 * group; a member with nothing on hand simply contributes no lots and no slice.
 */
export async function fetchGroupDraw(
  db: DbClient,
  { recipeId, variationIds, quantity }: { recipeId: string; variationIds: string[]; quantity: number },
): Promise<GroupDraw> {
  if (variationIds.length === 0) return { slices: [], shortfall: quantity };

  const { data, error } = await db
    .from("cold_storage_inventory")
    .select("variation_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .in("variation_id", variationIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return planGroupDraw(
    ((data ?? []) as { variation_id: string; quantity_on_hand: number | string; created_at: string }[]).map((r) => ({
      variationId: r.variation_id,
      quantityOnHand: Number(r.quantity_on_hand),
      createdAt: r.created_at,
    })),
    quantity,
  );
}

/**
 * The order the group's variations should be TRIED when the on-hand draw came up
 * short and higher tiers have to be cracked open.
 *
 * Same principle as the draw: oldest stock first. A variation with lots sorts by
 * its oldest lot; one with nothing on hand sorts last (there is nothing of its
 * age to reason about) but stays a candidate, because the tier being cracked
 * open lives in a DIFFERENT variation of the same family and may well be there.
 * Exported for unit testing.
 */
export function orderGroupByAge(lots: DrawLot[], variationIds: string[]): string[] {
  const oldestByVariation = new Map<string, string>();
  for (const lot of lots) {
    const seen = oldestByVariation.get(lot.variationId);
    if (seen === undefined || lot.createdAt.localeCompare(seen) < 0) {
      oldestByVariation.set(lot.variationId, lot.createdAt);
    }
  }
  return [...variationIds].sort((a, b) => {
    const av = oldestByVariation.get(a);
    const bv = oldestByVariation.get(b);
    if (av === undefined && bv === undefined) return a.localeCompare(b);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return av.localeCompare(bv) || a.localeCompare(b);
  });
}

/** Lots for a group, for callers that need the ordering as well as the draw. */
export async function fetchGroupLots(
  db: DbClient,
  { recipeId, variationIds }: { recipeId: string; variationIds: string[] },
): Promise<DrawLot[]> {
  if (variationIds.length === 0) return [];
  const { data, error } = await db
    .from("cold_storage_inventory")
    .select("variation_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .in("variation_id", variationIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { variation_id: string; quantity_on_hand: number | string; created_at: string }[]).map((r) => ({
    variationId: r.variation_id,
    quantityOnHand: Number(r.quantity_on_hand),
    createdAt: r.created_at,
  }));
}
