/**
 * Recorded pour volume over one keg's life — the measured half of shrinkage.
 *
 * Shrinkage is beer that left the keg with no transaction behind it:
 *
 *   shrinkage = full_keg_fl_oz − Σ(recorded pour fl oz while that keg was on)
 *
 * A $0 comp still carries a transaction, so it counts as recorded and is NOT
 * shrinkage — the sales path filters on quantity, never price, which is exactly
 * what that requires. Beer poured with no ring at all (foam dumped to pull a
 * clean pint, an off-book giveaway, line cleaning) has no line item, so it falls
 * out of the sum and lands in shrinkage. That is the whole definition.
 */
import { fetchOrderLineEvents, type OrderLineEvent } from "@/lib/square/inventory";
import { loadDraftPourVariations, type PourVar } from "./draftPourConsumption";

/** One recorded pour, in fl oz, at the time its order closed. */
export interface PourEvent {
  at: string;
  flOz: number;
}

export interface PourWindow {
  flOz: number;
  /** The pours behind `flOz`, in time order. Empty when summed from day buckets. */
  events: PourEvent[];
  /**
   * Pour variations with no fl oz mapping. Their sales are invisible to the sum,
   * so they would inflate shrinkage by exactly the volume they sold — a silent
   * "this beer is leaking" reading caused by a menu change, not by lost beer.
   * Non-empty means the window is unusable and the caller must fall back.
   */
  unmappedVariationIds: string[];
}

/**
 * Pure: day-bucketed pour sales ⇒ total fl oz for one recipe's pour variations.
 *
 * Day buckets are summed rather than filtered — the *request* carries the real
 * time bounds, so every bucket returned is already inside the window. That's why
 * this reads Square directly instead of the `draft_pour_consumption` ledger,
 * which is day-grain: a keg swapped at 6pm would split one day's pours across
 * two kegs and neither would be right.
 */
export function sumPourFlOz(
  salesByDay: Map<string, number>, // "<varId>\t<YYYY-MM-DD>" → units
  pourVars: PourVar[],
): PourWindow {
  const byVar = new Map<string, PourVar>();
  for (const v of pourVars) byVar.set(v.id, v);

  let flOz = 0;
  const unmapped = new Set<string>();
  for (const [key, units] of salesByDay) {
    const varId = key.split("\t")[0];
    const pv = byVar.get(varId);
    if (!pv) continue; // not a pour variation of this recipe
    if (pv.oz) flOz += units * pv.oz;
    else if (units > 0) unmapped.add(varId);
  }
  return { flOz, events: [], unmappedVariationIds: [...unmapped] };
}

/**
 * Pure: time-ordered pour line events ⇒ the window, with each pour kept as an
 * event so the running total can be walked. Same mapping rule as `sumPourFlOz`.
 */
export function sumPourEvents(lines: OrderLineEvent[], pourVars: PourVar[]): PourWindow {
  const byVar = new Map<string, PourVar>();
  for (const v of pourVars) byVar.set(v.id, v);

  let flOz = 0;
  const events: PourEvent[] = [];
  const unmapped = new Set<string>();
  for (const line of lines) {
    const pv = byVar.get(line.variationId);
    if (!pv) continue;
    if (pv.oz) {
      const oz = line.units * pv.oz;
      flOz += oz;
      events.push({ at: line.at, flOz: oz });
    } else if (line.units > 0) {
      unmapped.add(line.variationId);
    }
  }
  return { flOz, events, unmappedVariationIds: [...unmapped] };
}

/** A Draft Restock that was never rung, placed at the pour that must have blown the keg before it. */
export interface MissedRing {
  /** When the running pour total passed `kegIndex × full` — the keg before it was gone by then. */
  occurredAt: string;
  /** 1 = the first keg after the last ring blew unrecorded, 2 = the one after that, … */
  kegIndex: number;
}

/**
 * Pours past a whole keg that still read as a ring rung LATE rather than a keg
 * nobody rang. A bartender swaps the keg and rings the restock when they next
 * reach the register, a few pints later; that surplus belongs to the fresh keg
 * and is netted off its recount. Past this, the surplus is more beer than a
 * late walk to the register explains, and a keg went on with no ring at all.
 * Four pints.
 */
export const LATE_RING_TOLERANCE_FL_OZ = 64;

/**
 * Pure: where, in one tap's pour stream between two rings, each keg that was
 * never rung must have gone on.
 *
 * Every keg holds `fullFlOz`. Walk the pours in time order; each time the
 * running total passes a whole-keg multiple by more than the late-ring
 * tolerance, the keg that was pouring had to have been swapped by then with no
 * Draft Restock rung for it. The pour that tips the total over is the closest
 * timestamp the receipts can give.
 *
 * A total of exactly one keg means the keg blew at that pour and THIS ring is
 * the one for it; a few pints past it is this ring rung late. Neither is a
 * missed keg.
 */
export function inferMissedRings(
  events: PourEvent[],
  fullFlOz: number,
  toleranceFlOz: number = LATE_RING_TOLERANCE_FL_OZ,
): MissedRing[] {
  if (fullFlOz <= 0) return [];
  const missed: MissedRing[] = [];
  let cumulative = 0;
  let kegIndex = 1;
  for (const e of events) {
    cumulative += e.flOz;
    while (cumulative > kegIndex * fullFlOz + toleranceFlOz) {
      missed.push({ occurredAt: e.at, kegIndex });
      kegIndex++;
    }
  }
  return missed;
}

/**
 * Recorded pour fl oz for `recipeId` between two restock rings.
 *
 * `sinceIso` is the tap's previous ring and `untilIso` this one, so the window
 * is bounded by the same events that bound the keg. Returns null when the recipe
 * has no pour variations configured at all — there is nothing to measure, and
 * the caller should fall back rather than report a full keg of shrinkage.
 */
export async function fetchPourFlOzBetween(
  supabase: Parameters<typeof loadDraftPourVariations>[0],
  recipeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<PourWindow | null> {
  const pourVarsByRecipe = await loadDraftPourVariations(supabase);
  return fetchPourFlOzBetweenWith(pourVarsByRecipe, recipeId, sinceIso, untilIso);
}

/**
 * Same, with the pour-variation map already loaded. The sync resolves several
 * restocks per run and the map is a two-query catalog read, so it loads once.
 */
export async function fetchPourFlOzBetweenWith(
  pourVarsByRecipe: Map<string, PourVar[]>,
  recipeId: string,
  sinceIso: string,
  untilIso: string,
): Promise<PourWindow | null> {
  const pourVars = pourVarsByRecipe.get(recipeId);
  if (!pourVars || pourVars.length === 0) return null;

  // fetchOrderLineEvents takes RFC3339 bounds verbatim and already drops invoice
  // orders and internal keg-transfer lines — the same exclusions the pour ledger
  // uses, so the two lenses can't disagree about what counts as a sale. Events
  // rather than day buckets, so a missed ring can be placed at the pour that
  // blew the keg, not just the day.
  const lines = await fetchOrderLineEvents(
    sinceIso,
    untilIso,
    pourVars.map((v) => v.id),
  );
  return sumPourEvents(lines, pourVars);
}
