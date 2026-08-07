import { SupabaseClient } from "@supabase/supabase-js";
import { deriveTaproomConsumption, trailingWindow, type ConsumptionKind, type AssemblyDiscrepancy } from "@/lib/square/taproomConsumption";
import { setPhysicalCount, fetchCurrentCounts } from "@/lib/square/inventory";
import { recordTaproomConsumption } from "@/lib/production/recordTaproomConsumption";
import { pushInventoryToSquare } from "@/lib/production/pushInventoryToSquare";
import { PUSH_TO_SQUARE_ENABLED } from "@/lib/square/pushGate";
import { syncDraftPourConsumption } from "./syncDraftPourConsumption";
import { buildRetirePayload } from "@/lib/taproom/retireRecipe";
import { fetchPourFlOzBetweenWith } from "@/lib/taproom/kegPourWindow";
import { loadDraftPourVariations, type PourVar } from "@/lib/taproom/draftPourConsumption";
import type { PendingTapSwap } from "@/lib/taproom/tapSwaps";

/**
 * Reconciling taproom-consumption sync.
 *
 * Idempotent by design: every run re-derives target consumption from Square and
 * records only `target − already_recorded` per source_ref, bounded by cold-storage
 * on-hand (recordTaproomConsumption never goes negative). Re-running converges —
 * fully-recorded units yield a zero delta; short-stock and unconfigured-draft
 * units stay flagged until their upstream cause is fixed, then self-clear on the
 * next run. Shared by the sync route and the daily cron.
 */

export interface RecordedLine {
  kind: ConsumptionKind;
  recipeId: string;
  variationId: string;
  sourceRef: string;
  label: string;
  recordedQty: number;
}

export type SyncDiscrepancy =
  | AssemblyDiscrepancy
  | {
      kind: "short_stock";
      recipeId: string;
      variationId: string;
      label: string;
      requestedQty: number;
      recordedQty: number;
      shortfallQty: number;
    }
  | {
      kind: "recount_failed";
      sourceRef: string;
      label: string;
      detail: string;
    }
  | {
      kind: "shrinkage_capture_failed";
      sourceRef: string;
      detail: string;
    }
  | {
      /**
       * A pour size on the menu with no fl oz mapping, found while measuring a
       * keg's shrinkage. Its sales are invisible to the pour sum, so shrinkage
       * fell back to Square's on-hand for this keg. Left unfixed, every keg of
       * this beer keeps measuring the weaker way — map the variation's size in
       * the Square catalog to clear it.
       */
      kind: "unmapped_pour_size";
      recipeId: string;
      sourceRef: string;
      squareVariationIds: string[];
    }
  | {
      /**
       * More pour volume was recorded than the keg could hold. Shrinkage can't be
       * negative, so this is never a measurement — it means the restock was rung
       * after the keg was already swapped, and the surplus belongs to the NEXT
       * keg. It IS netted out of the incoming recount, but it's surfaced because
       * the shrinkage figure for the keg that just came off is unusable.
       */
      kind: "restock_overdraft";
      sourceRef: string;
      recipeId: string;
      tapNumber: number | null;
      overdraftFlOz: number;
    }
  | {
      /**
       * A beer-change swap whose outgoing beer is still pouring on another tap.
       * The draft SKU is per recipe, so its count is the combined level across
       * both taps — zeroing it would wipe the other tap's beer and the residual
       * reading would be wrong. Write-off and zeroing are skipped.
       */
      kind: "multi_tap_outgoing_skipped";
      tapNumber: number;
      recipeId: string;
      beerName: string | null;
    };

export interface TaproomSyncResult {
  shipmentId: string;
  windowDays: number;
  /** True when another sync run held the lease lock and this run skipped entirely. */
  lockSkipped: boolean;
  /**
   * The span of Square activity this run actually inspected, or `null` when it
   * never got to look because another run held the lease.
   *
   * A safety net that reports only what it recorded cannot be audited: "recorded
   * 0" is what a healthy night looks like when the webhook already booked
   * everything, and it is also what a run looking at the wrong window, or at
   * nothing at all, looks like. Between 2026-07-06 and 2026-08-06 every one of
   * the 25 successful nightly runs reported `recordedUnits: 0` while 55 units
   * sat unbooked, and nothing in the summary could tell those two states apart.
   * The window plus `unitsExamined` below are what make them distinguishable.
   */
  window: import("@/lib/square/taproomConsumption").ConsumptionWindow | null;
  /** Consumption units the window yielded — the population the counters below partition. */
  unitsExamined: number;
  recorded: RecordedLine[];
  recordedUnits: number;
  /**
   * Units that needed nothing because `export_transactions` already covered them.
   * This is the healthy steady state behind the webhook.
   */
  alreadyRecorded: number;
  /**
   * Units this run tried to book and got nothing for. Distinct from
   * `alreadyRecorded` in the one way that matters: something was owed and the
   * run failed to book it, which is a fault rather than a no-op.
   */
  bookedNothing: number;
  /** `alreadyRecorded + bookedNothing`. Retained so existing readers keep working. */
  skipped: number;
  totalRecordedQty: number;
  recountsApplied: number;
  /** Queued beer-change transitions this run claimed and booked. */
  swapsConsumed: number;
  packsBrokenDown: number;
  packagingWarnings: string[];
  discrepancies: SyncDiscrepancy[];
  squareWriteback: {
    applied: number;
    /** Corrections the push would send; populated whether or not the gate is open. */
    planned: import("./pushInventoryToSquare").PushOutcome["planned"];
    warnings: string[];
    pushEnabled: boolean;
  };
}

const EPS = 1e-4;

// Serializes concurrent sync runs. The Square webhook fires this sync on every
// order.* event, so one restock's event burst triggers several overlapping runs;
// without a lock they each read "0 already recorded" and write duplicate rows.
// TTL exceeds the longest possible run (cron ≤ Vercel maxDuration) so a live run
// is never stolen; a hard-killed holder self-clears after it.
const LOCK_JOB = "taproom_consumption_sync";
const LOCK_TTL_SECONDS = 300;

/** Remaining units to record for a unit given what's already booked (never negative). */
export function remainingDelta(targetQty: number, alreadyRecorded: number): number {
  const d = targetQty - alreadyRecorded;
  return d > EPS ? d : 0;
}

/**
 * Split a keg's closing balance into shrinkage and overdraft.
 *
 * The balance is `full_keg_fl_oz − recorded pour fl oz` over the keg's life.
 * Square's on-hand for the draft SKU is the same quantity computed by Square, so
 * both measurement paths below feed this one function.
 *
 * A keg is swapped when it blows, so whatever the balance still shows is beer
 * that left with no transaction behind it — foam, off-book giveaways, line
 * cleaning. That is the shrinkage.
 *
 * A NEGATIVE balance cannot be shrinkage: you can't lose less than nothing. It
 * means more pours were recorded than the keg could hold, which happens when a
 * restock is rung late — the keg was swapped hours earlier and every pour since
 * belongs to the NEXT keg. That surplus is the overdraft, and it has to come off
 * the incoming keg's recount target or Square hands the tap back beer it has
 * already poured.
 */
export function splitKegBalance(balanceFlOz: number): { unaccountedFlOz: number; overdraftFlOz: number } {
  return balanceFlOz >= 0
    ? { unaccountedFlOz: balanceFlOz, overdraftFlOz: 0 }
    : { unaccountedFlOz: 0, overdraftFlOz: -balanceFlOz };
}

/**
 * Absolute fl oz to recount a fresh keg to: full volume less what it already
 * poured before the restock was rung. Floored at zero — an overdraft bigger than
 * a keg means more than one missed restock, and writing the count negative again
 * would just carry the same error forward.
 */
export function recountTarget(fullFlOz: number, overdraftFlOz: number): number {
  const t = fullFlOz - overdraftFlOz;
  return t > 0 ? t : 0;
}

/** How a keg's closing balance was measured. */
export type BalanceSource = "pours" | "square_on_hand";

export interface KegBalance {
  unaccountedFlOz: number;
  overdraftFlOz: number;
  source: BalanceSource;
}

/**
 * Measure the balance of the keg coming off a tap.
 *
 * Preferred path sums the pour transactions recorded between this tap's previous
 * restock ring and this one and subtracts them from the keg's full volume — that
 * IS the definition of shrinkage, computed from receipts we own.
 *
 * Falls back to Square's on-hand for the draft SKU when the pour sum can't be
 * trusted: no previous ring to bound the window (first restock on this tap), no
 * pour variations configured, or a pour size with no fl oz mapping. That last
 * case matters most — an unmapped pour size makes real sales invisible, so the
 * sum would report the volume it sold as missing beer. The Square read carries
 * the opposite bias (it doesn't decrement for unmapped pours either, so the error
 * cancels), which is exactly why it stays as the safety net.
 */
export async function measureKegBalance(opts: {
  pourVarsByRecipe: Map<string, PourVar[]>;
  recipeId: string;
  fullFlOz: number;
  lastRestockAt: string | null;
  occurredAt: string;
  squareVariationId: string;
}): Promise<{ balance: KegBalance | null; unmappedVariationIds: string[] }> {
  const { pourVarsByRecipe, recipeId, fullFlOz, lastRestockAt, occurredAt, squareVariationId } = opts;

  let unmappedVariationIds: string[] = [];
  if (lastRestockAt && fullFlOz > 0 && lastRestockAt < occurredAt) {
    const window = await fetchPourFlOzBetweenWith(pourVarsByRecipe, recipeId, lastRestockAt, occurredAt);
    if (window && window.unmappedVariationIds.length === 0) {
      return {
        balance: { ...splitKegBalance(fullFlOz - window.flOz), source: "pours" },
        unmappedVariationIds,
      };
    }
    unmappedVariationIds = window?.unmappedVariationIds ?? [];
  }

  const counts = await fetchCurrentCounts([squareVariationId]);
  const onHand = counts.get(squareVariationId);
  if (onHand === undefined) return { balance: null, unmappedVariationIds };
  return { balance: { ...splitKegBalance(onHand), source: "square_on_hand" }, unmappedVariationIds };
}

/** Sum of already-recorded quantity per source_ref (chunked to stay under `in` limits). */
async function recordedByRef(supabase: SupabaseClient, refs: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < refs.length; i += 300) {
    const chunk = refs.slice(i, i + 300);
    const { data, error } = await supabase
      .from("export_transactions")
      .select("source_ref, quantity")
      .in("source_ref", chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const ref = row.source_ref as string;
      map.set(ref, (map.get(ref) ?? 0) + Number(row.quantity));
    }
  }
  return map;
}

/**
 * Claim a queued beer-change transition and book its OUTGOING side.
 *
 * This is the one path where a keg comes off NOT empty: the beer is being
 * changed, so a half-full keg gets pulled and dumped. Its balance is therefore
 * dominated by a deliberate decision rather than by foam and giveaways, which is
 * why the row is stamped `cause: "beer_change"` — averaging it in with blown
 * kegs would swamp the real shrinkage signal. Either way it's a loss belonging to
 * the OUTGOING recipe, and that recipe's per-tap draft SKU must be zeroed or it
 * reports on-hand draft forever while pouring on no tap.
 *
 * Fire-once rests on the conditional UPDATE below: the Square webhook fires this
 * sync on every `order.*` event, so one restock spawns a burst of overlapping
 * runs. Whichever run's update matches `consumed_source_ref IS NULL` owns the
 * outgoing side; the rest get zero rows back and do nothing.
 *
 * Returns `overdraftFlOz` — pour volume recorded beyond what the outgoing keg
 * could hold, which belongs to the INCOMING keg (see `splitKegBalance`) and so
 * has to come off its recount target. Zero whenever the balance couldn't be read.
 */
async function consumeSwapTransition(
  supabase: SupabaseClient,
  swap: PendingTapSwap,
  sourceRef: string,
  occurredAt: string,
  pourVarsByRecipe: Map<string, PourVar[]>,
  lastRestockAt: string | null,
): Promise<{ claimed: boolean; overdraftFlOz: number; discrepancies: SyncDiscrepancy[] }> {
  const discrepancies: SyncDiscrepancy[] = [];
  const nowIso = new Date().toISOString();

  const { data: claimedRows, error: claimErr } = await supabase
    .from("tap_swap_transitions")
    .update({ consumed_source_ref: sourceRef, consumed_at: nowIso })
    .eq("id", swap.id)
    .is("consumed_source_ref", null)
    .select("id");
  if (claimErr) throw new Error(`swap claim failed: ${claimErr.message}`);
  if ((claimedRows ?? []).length === 0) return { claimed: false, overdraftFlOz: 0, discrepancies };

  // The keg physically changed, so the tap now pours the incoming beer. Only the
  // variation moves — the recount target follows it, joined from that variation
  // wherever it is read, so there is no second copy here to fall out of step.
  const { error: flipErr } = await supabase
    .from("tap_assignments")
    .update({
      recipe_id:         swap.toRecipeId,
      swap_variation_id: swap.toVariationId,
      updated_at:        nowIso,
    })
    .eq("tap_number", swap.tapNumber);
  if (flipErr) throw new Error(`tap flip failed: ${flipErr.message}`);

  // Tapping a beer is an unambiguous statement that it's active. Leaving
  // is_retired set would make the batch scheduler refuse to brew more of a beer
  // that's actively pouring — a silent stockout.
  const { error: unretireErr } = await supabase
    .from("taproom_recipe_settings")
    .upsert(buildRetirePayload(swap.toRecipeId, false, nowIso), { onConflict: "recipe_id" });
  if (unretireErr) throw new Error(`un-retire failed: ${unretireErr.message}`);

  // Filling a previously empty tap — no keg came off, nothing to write off.
  if (!swap.fromRecipeId) return { claimed: true, overdraftFlOz: 0, discrepancies };

  // Run AFTER the flip so this tap doesn't count itself.
  const { data: otherTaps, error: otherErr } = await supabase
    .from("tap_assignments")
    .select("tap_number")
    .eq("recipe_id", swap.fromRecipeId);
  if (otherErr) throw new Error(`multi-tap check failed: ${otherErr.message}`);
  if ((otherTaps ?? []).length > 0) {
    discrepancies.push({
      kind: "multi_tap_outgoing_skipped",
      tapNumber: swap.tapNumber,
      recipeId: swap.fromRecipeId,
      beerName: swap.fromBeerName,
    });
    return { claimed: true, overdraftFlOz: 0, discrepancies };
  }

  if (!swap.fromDraftSquareVariationId) {
    discrepancies.push({
      kind: "shrinkage_capture_failed",
      sourceRef,
      detail: `outgoing recipe ${swap.fromRecipeId} has no draft Square link — residual neither captured nor zeroed`,
    });
    return { claimed: true, overdraftFlOz: 0, discrepancies };
  }

  // Measure BEFORE zeroing — the Square fallback inside `measureKegBalance` reads
  // the very SKU the zeroing below overwrites.
  // Best-effort throughout — a Square failure must never block the incoming side.
  let overdraftFlOz = 0;
  try {
    const { balance, unmappedVariationIds } = await measureKegBalance({
      pourVarsByRecipe,
      recipeId:          swap.fromRecipeId,
      fullFlOz:          swap.fromVolumeFlOz ?? 0,
      lastRestockAt,
      occurredAt,
      squareVariationId: swap.fromDraftSquareVariationId,
    });
    if (unmappedVariationIds.length > 0) {
      discrepancies.push({
        kind: "unmapped_pour_size",
        recipeId: swap.fromRecipeId,
        sourceRef,
        squareVariationIds: unmappedVariationIds,
      });
    }
    if (balance) {
      overdraftFlOz = balance.overdraftFlOz;
      if (balance.overdraftFlOz > EPS) {
        discrepancies.push({
          kind: "restock_overdraft",
          sourceRef,
          recipeId: swap.fromRecipeId,
          tapNumber: swap.tapNumber,
          overdraftFlOz: balance.overdraftFlOz,
        });
      }
      const { error } = await supabase.from("draft_swap_shrinkage").upsert({
        source_ref:        sourceRef,
        recipe_id:         swap.fromRecipeId,
        tap_number:        swap.tapNumber,
        occurred_at:       occurredAt,
        unaccounted_fl_oz: balance.unaccountedFlOz,
        full_fl_oz:        swap.fromVolumeFlOz ?? 0,
        cause:             "beer_change",
      }, { onConflict: "source_ref" });
      if (error) throw new Error(error.message);
    }
    await setPhysicalCount(swap.fromDraftSquareVariationId, 0, occurredAt);
  } catch (e) {
    discrepancies.push({
      kind: "shrinkage_capture_failed",
      sourceRef,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return { claimed: true, overdraftFlOz, discrepancies };
}

export async function runTaproomConsumptionSync(
  supabase: SupabaseClient,
  { days }: { days: number },
): Promise<TaproomSyncResult> {
  const shipmentId = crypto.randomUUID();

  // Claim the lease before touching any data. If another run holds it, skip
  // entirely — the trailing window plus the daily cron re-cover anything missed,
  // matching this sync's existing "self-heals on the next trigger" contract.
  const { data: acquired, error: lockErr } = await supabase.rpc("try_acquire_sync_lock", {
    p_job: LOCK_JOB,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (lockErr) throw new Error(`taproom sync lock acquire failed: ${lockErr.message}`);
  if (!acquired) {
    // `window: null` is the whole point: this run inspected nothing, which must
    // not read like a run that inspected a window and found it clean.
    return {
      shipmentId, windowDays: days, lockSkipped: true, window: null, unitsExamined: 0,
      recorded: [], recordedUnits: 0, alreadyRecorded: 0, bookedNothing: 0, skipped: 0, totalRecordedQty: 0,
      recountsApplied: 0, swapsConsumed: 0, packsBrokenDown: 0, packagingWarnings: [], discrepancies: [],
      squareWriteback: { applied: 0, planned: [], warnings: [], pushEnabled: PUSH_TO_SQUARE_ENABLED },
    };
  }

  try {
  const window = trailingWindow(new Date(), days);
  const { units, discrepancies: configDiscrepancies } = await deriveTaproomConsumption(supabase, { days, window });

  const refs = [...new Set(units.map((u) => u.sourceRef))];
  const recorded = refs.length ? await recordedByRef(supabase, refs) : new Map<string, number>();

  const recordedLines: RecordedLine[] = [];
  const shortStock: SyncDiscrepancy[] = [];
  const recountWarnings: SyncDiscrepancy[] = [];
  const shrinkageWarnings: SyncDiscrepancy[] = [];
  const swapWarnings: SyncDiscrepancy[] = [];
  let alreadyRecorded = 0;
  let bookedNothing = 0;
  let totalRecordedQty = 0;
  let recountsApplied = 0;
  let swapsConsumed = 0;
  let packsBrokenDown = 0;
  const packagingWarnings = new Set<string>();

  // Shrinkage measurement inputs, loaded once per run and only when a restock is
  // actually in the window — both are catalog/config reads that a sales-only run
  // has no use for. `lastRestockAt` is the lower bound of each keg's pour window;
  // it stays null for a tap whose first restock this is, which falls the
  // measurement back to Square's on-hand.
  const hasRestock = units.some((u) => u.kind === "draft_swap");
  const pourVarsByRecipe = hasRestock
    ? await loadDraftPourVariations(supabase)
    : new Map<string, PourVar[]>();
  const lastRestockByTap = new Map<number, string | null>();
  if (hasRestock) {
    const { data: tapRows, error: tapErr } = await supabase
      .from("tap_assignments")
      .select("tap_number, last_restock_at");
    if (tapErr) throw new Error(`tap restock anchors failed: ${tapErr.message}`);
    for (const t of (tapRows ?? []) as { tap_number: number; last_restock_at: string | null }[]) {
      lastRestockByTap.set(t.tap_number, t.last_restock_at);
    }
  }

  for (const u of units) {
    const unitAlreadyRecorded = recorded.get(u.sourceRef) ?? 0;
    const delta = remainingDelta(u.quantity, unitAlreadyRecorded);
    if (delta <= 0) { alreadyRecorded++; continue; }

    const res = await recordTaproomConsumption(supabase, {
      shipmentId,
      recipeId: u.recipeId,
      variationId: u.variationId,
      quantity: delta,
      sourceRef: u.sourceRef,
      notes: null,
      kind: u.kind,
    });

    // A break that mutated inventory (parent decremented/deleted, child
    // credited) is counted even if nothing ended up recordable afterward
    // (e.g. the topped-up tier still fell short of `delta`).
    packsBrokenDown += res.breaks.length;
    for (const w of res.warnings) packagingWarnings.add(w);

    if (res.recordedQty > EPS) {
      recordedLines.push({
        kind: u.kind,
        recipeId: u.recipeId,
        variationId: u.variationId,
        sourceRef: u.sourceRef,
        label: u.label,
        recordedQty: res.recordedQty,
      });
      totalRecordedQty += res.recordedQty;

    } else {
      // Something was owed for this unit and none of it landed. Counted apart
      // from `alreadyRecorded` — folding the two together is what let a run that
      // booked nothing read exactly like a run with nothing to book.
      bookedNothing++;
    }

    // Pour volume recorded beyond what the outgoing keg could hold — the mark of a
    // restock rung late — netted out of the incoming keg's recount target below.
    let overdraftFlOz = 0;
    const restockAt = u.occurredAt ?? u.recount?.occurredAt ?? new Date().toISOString();
    const lastRestockAt = u.tapNumber != null ? lastRestockByTap.get(u.tapNumber) ?? null : null;

    // A queued beer-change transition: claim it, then book the OUTGOING side
    // (write off the pulled keg against the OLD beer, zero its Square draft SKU),
    // flip the tap and un-retire the incoming beer. Gated exactly like the recount
    // below so a unit that books nothing never claims.
    if (u.swap && unitAlreadyRecorded === 0 && res.recordedQty + res.shortfallQty > EPS) {
      const outcome = await consumeSwapTransition(
        supabase,
        u.swap,
        u.sourceRef,
        restockAt,
        pourVarsByRecipe,
        lastRestockAt,
      );
      if (outcome.claimed) swapsConsumed++;
      // On a beer change the overdraft is measured against the OUTGOING keg —
      // that's the one the tap kept ringing while the new keg poured.
      overdraftFlOz = outcome.overdraftFlOz;
      swapWarnings.push(...outcome.discrepancies);
    }

    // Restock-driven swaps carry a recount. Fire it once — on the first run
    // that durably records this swap (unitAlreadyRecorded === 0), whether that
    // record was physical, phantom, or both — so the mapped draft SKU is
    // reset to full in Square even when cold storage had nothing to
    // physically deplete. Tying it to a persisted shipment row guarantees
    // fire-once: subsequent runs see unitAlreadyRecorded > 0 and skip.
    // Best-effort: a Square failure is flagged, never fatal.
    if (u.recount && unitAlreadyRecorded === 0 && res.recordedQty + res.shortfallQty > EPS) {
      // Shrinkage for the keg that just blew: its full volume less every pour
      // transaction recorded since this tap's previous restock. The measurement
      // is unconditional (the overdraft has to be netted out of the recount
      // whether or not cold storage moved), but the shrinkage ROW is gated on
      // physical inventory actually moving — a phantom-only swap never touched a
      // keg, so there is no keg to attribute a loss to. Best-effort — never
      // fatal, so a read/write failure can't block the recount.
      //
      // Skipped entirely for a beer-change swap: `u.recount.squareVariationId` is
      // then the INCOMING beer's SKU and `u.recipeId` the incoming recipe, neither
      // of which says anything about the keg that came off.
      // `consumeSwapTransition` measured the outgoing side above.
      if (!u.swap) {
        try {
          const { balance, unmappedVariationIds } = await measureKegBalance({
            pourVarsByRecipe,
            recipeId:          u.recipeId,
            fullFlOz:          u.recount.quantity,
            lastRestockAt,
            occurredAt:        u.recount.occurredAt,
            squareVariationId: u.recount.squareVariationId,
          });
          if (unmappedVariationIds.length > 0) {
            shrinkageWarnings.push({
              kind: "unmapped_pour_size",
              recipeId: u.recipeId,
              sourceRef: u.sourceRef,
              squareVariationIds: unmappedVariationIds,
            });
          }
          if (balance) {
            overdraftFlOz = balance.overdraftFlOz;
            if (balance.overdraftFlOz > EPS) {
              shrinkageWarnings.push({
                kind: "restock_overdraft",
                sourceRef: u.sourceRef,
                recipeId: u.recipeId,
                tapNumber: u.tapNumber ?? null,
                overdraftFlOz: balance.overdraftFlOz,
              });
            }
            if (res.recordedQty > EPS) {
              const { error } = await supabase.from("draft_swap_shrinkage").upsert({
                source_ref:        u.sourceRef,
                recipe_id:         u.recipeId,
                tap_number:        u.tapNumber ?? null,
                occurred_at:       u.recount.occurredAt,
                unaccounted_fl_oz: balance.unaccountedFlOz,
                full_fl_oz:        u.recount.quantity,
                cause:             "keg_emptied",
              }, { onConflict: "source_ref" });
              if (error) throw new Error(error.message);
            }
          }
        } catch (e) {
          shrinkageWarnings.push({
            kind: "shrinkage_capture_failed",
            sourceRef: u.sourceRef,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }

      try {
        await setPhysicalCount(
          u.recount.squareVariationId,
          recountTarget(u.recount.quantity, overdraftFlOz),
          u.recount.occurredAt,
        );
        recountsApplied++;
      } catch (e) {
        recountWarnings.push({
          kind: "recount_failed",
          sourceRef: u.sourceRef,
          label: u.label,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Advance the tap's pour-window anchor so the NEXT keg is measured from this
    // ring forward. Gated on the same fire-once condition as the recount, but
    // deliberately independent of `u.recount` — a tap whose recipe has no draft
    // Square link still needs its window to move, or the following keg would be
    // charged with every pour since the last tap that did have one.
    // Monotonic: a late-arriving older ring in the trailing window must not drag
    // the anchor backwards. Best-effort — a failure here only costs the next
    // keg's measurement its preferred path, and it falls back cleanly.
    if (u.kind === "draft_swap" && u.tapNumber != null && unitAlreadyRecorded === 0
        && res.recordedQty + res.shortfallQty > EPS) {
      const prior = lastRestockByTap.get(u.tapNumber) ?? null;
      if (!prior || restockAt > prior) {
        const { error } = await supabase
          .from("tap_assignments")
          .update({ last_restock_at: restockAt })
          .eq("tap_number", u.tapNumber);
        if (error) {
          shrinkageWarnings.push({
            kind: "shrinkage_capture_failed",
            sourceRef: u.sourceRef,
            detail: `pour-window anchor not advanced: ${error.message}`,
          });
        } else {
          lastRestockByTap.set(u.tapNumber, restockAt);
        }
      }
    }

    if (res.shortfallQty > EPS) {
      shortStock.push({
        kind: "short_stock",
        recipeId: u.recipeId,
        variationId: u.variationId,
        label: u.label,
        requestedQty: delta,
        recordedQty: res.recordedQty,
        shortfallQty: res.shortfallQty,
      });
    }
  }

  // Reflect cold storage back onto Square for every recipe this run drained.
  //
  // Covers KEG sales as well as can sales now. The old call reconciled cans
  // only, so a keg sold to go depleted cold storage and left Square's keg count
  // untouched — 55 mapped keg SKUs that were never written.
  //
  // Delegates to the shared push so this path and the nightly job cannot drift
  // apart in what they consider pushable, and so both honour the same gate.
  // Best-effort — a Square failure is logged, never fatal.
  const touchedRecipeIds = [...new Set(
    units.filter((u) => u.kind === "can_sale" || u.kind === "keg_sale").map((u) => u.recipeId),
  )];
  let squareWriteback = {
    applied: 0,
    planned: [] as import("./pushInventoryToSquare").PushOutcome["planned"],
    warnings: [] as string[],
    pushEnabled: PUSH_TO_SQUARE_ENABLED,
  };
  if (touchedRecipeIds.length > 0) {
    try {
      const rc = await pushInventoryToSquare(supabase, { recipeIds: touchedRecipeIds });
      squareWriteback = { applied: rc.applied, planned: rc.planned, warnings: rc.warnings, pushEnabled: rc.pushEnabled };
    } catch (e) {
      squareWriteback.warnings.push(`square push failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Populate the operational pour ledger (sell-through / shrinkage lens) for the
  // trailing window. Strictly additive to the accounting write path above and
  // never fatal — a pour-ledger failure is flagged as a warning, not thrown.
  try {
    await syncDraftPourConsumption(supabase, { days });
  } catch (e) {
    packagingWarnings.add(`draft_pour_consumption sync failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    shipmentId,
    windowDays: days,
    lockSkipped: false,
    window,
    unitsExamined: units.length,
    recorded: recordedLines,
    recordedUnits: recordedLines.length,
    alreadyRecorded,
    bookedNothing,
    skipped: alreadyRecorded + bookedNothing,
    totalRecordedQty: Math.round(totalRecordedQty * 10000) / 10000,
    recountsApplied,
    swapsConsumed,
    packsBrokenDown,
    packagingWarnings: [...packagingWarnings],
    discrepancies: [...configDiscrepancies, ...shortStock, ...recountWarnings, ...shrinkageWarnings, ...swapWarnings],
    squareWriteback,
  };
  } finally {
    // Always release, even on throw, so a failed run never wedges the lease for
    // the full TTL. A release failure is logged, not thrown — the TTL is the
    // backstop and we don't want to mask the original error.
    const { error: relErr } = await supabase.rpc("release_sync_lock", { p_job: LOCK_JOB });
    if (relErr) console.error("[taproom-sync] lock release failed", relErr.message);
  }
}
