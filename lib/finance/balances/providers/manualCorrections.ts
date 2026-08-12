/**
 * Hand-typed movements on an account whose calculation has no postings step.
 *
 * ── The hole this fills ──────────────────────────────────────────────────────
 * Most balance-sheet methods end in a `transactionPostings` step, which counts
 * manual entries of kind "flow" alongside the feeds. That is how a correction
 * reaches a calculated account: an operator types the movement, and it composes
 * with everything else exactly like an expense would.
 *
 * Two methods had no such step, and the codebase said otherwise. The gift card
 * method's own comment claimed "a hand-typed correction still reaches the
 * account through Manual Entries, which is the arrangement for an adjustment on
 * a calculated account generally". It did not. GL 2410 and GL 3300 read only
 * their own calculations, so an entry typed against either was accepted, stored,
 * shown in the Manual Entries ledger, and silently ignored by the balance sheet
 * -- the worst available outcome, because the operator had every reason to
 * believe it had worked.
 *
 * ── Why not just add `transactionPostings` to those methods ──────────────────
 * Because it would count more than corrections, and on GL 2410 that is a real
 * double-count waiting to happen: the gift card method already counts
 * redemptions from the card payment on each till receipt, so an order line that
 * happened to be coded to 2410 would be counted once by `giftCardsRedeemed` and
 * again by the postings roll-up. Nothing is coded there today, which makes it a
 * trap rather than a bug -- it would appear the first time somebody coded a
 * line to the account, months from now, as an unexplained drift.
 *
 * This provider reads manual entries and NOTHING else, so it cannot double-count
 * a feed row by construction. It is the narrow half of `transactionPostings`,
 * for methods that want the corrections without the roll-up.
 *
 * ── Null, never zero ─────────────────────────────────────────────────────────
 * No entries at all returns null, so this step contributes nothing and the
 * account still reads from its own calculation. Entries that happen to sum to
 * zero return 0, which is a real answer: somebody typed a correction and its
 * reversal, and the account is genuinely unmoved.
 */
import { sumManualFlowEntries } from "./manualFlowEntries";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

export const manualCorrections: BalanceProvider = {
  key: "manualCorrections",
  label: "Corrections entered by hand",
  kind: "derived",
  readsManualFlow: true,
  async compute(ctx: BalanceContext): Promise<number | null> {
    const { sum, count } = await sumManualFlowEntries(ctx.supabase, ctx.coaId, ctx.periodEnd);
    return count === 0 ? null : sum;
  },
};

registerProvider(manualCorrections);
