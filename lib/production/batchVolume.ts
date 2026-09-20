/**
 * The one definition of "how big is a batch".
 *
 * Four different numbers get called batch volume. Only the first is stored on
 * `brew_batches.volume_bbl`:
 *
 *  1. FILL — what goes into the brewhouse: BREWHOUSE_BBL × turns, pre-loss.
 *     This is `brew_batches.volume_bbl`. It seeds the volume ledger (packaged +
 *     converted + shrinkage sums back to it), it is the denominator of every
 *     allocation percentage, and it is what the partner portal quotes. It is
 *     derived from turns — a client never chooses it. A DB trigger
 *     (`brew_batches_derive_volume`) enforces the same rule.
 *     Exception: a conversion-born batch (`converted_from_batch_id` set) never
 *     saw the brewhouse; its volume is what the conversion delivered.
 *  2. EXPECTED YIELD — recipe.expected_yield_bbl × turns, post-loss. A forecast
 *     for demand planning and packaging targets. Derived on read, never stored.
 *  3. PRODUCED — what the ledger says was packaged. Measured, never typed.
 *  4. BOOKED — commitments.volume_bbl, a partner's pre-shrinkage claim on the
 *     fill. Entitlement is percentage × produced, capped at booked.
 */

export const BREWHOUSE_BBL = 20;

function wholeTurns(turns: number | null | undefined): number {
  return Math.max(1, Math.floor(Number(turns) || 1));
}

/** brew_batches.volume_bbl for a brewed (non-conversion) batch. */
export function batchFillBbl(turns: number | null | undefined): number {
  return BREWHOUSE_BBL * wholeTurns(turns);
}

/**
 * Forecast post-loss output. A recipe with no expected yield forecasts no loss
 * rather than an invented figure.
 */
export function expectedYieldBbl(
  expectedYieldPerTurn: number | null | undefined,
  turns: number | null | undefined,
): number {
  const perTurn = Number(expectedYieldPerTurn);
  return (perTurn > 0 ? perTurn : BREWHOUSE_BBL) * wholeTurns(turns);
}
