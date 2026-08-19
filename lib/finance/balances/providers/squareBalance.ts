/**
 * GL 1040 Square Deposit Account — anchor plus movement.
 *
 * ── Why this account cannot simply be read ───────────────────────────────────
 * Square publishes no balance endpoint. Verified against the live v2 API, not
 * assumed: `ListBankAccounts` returns account metadata with no balance field at
 * all, and the only `balance` fields anywhere in v2 belong to gift cards and
 * loyalty. The balance has to be derived.
 *
 * ── The derivation, and why it stops where it does ───────────────────────────
 *   balance = last verified balance
 *           + everything Square settled in since
 *           - what the bank recognised arriving from Square since
 *
 * The money-IN half is exact. Payouts into the Square stored balance are
 * already net of processing fees and refunds, and Square's own totals reconcile
 * to the cent (see lib/square/payouts.ts). So this is not an estimate that
 * happens to be close; the inflow term is Square's own arithmetic.
 *
 * The money-OUT half is real and Square reports none of it, which is why this
 * account is derived from two sides rather than read from one.
 *
 * Money DOES move from the Square balance to the bank. Square holds a verified
 * Chase checking account for this merchant (routing 028000121, ending 077,
 * creditable and debitable) and sweeps to it happen. Square itself will not say
 * so:
 *   * not the payouts feed -- transfers off the stored balance are not modelled
 *     as payouts at all. Queried back to 2021, across every location and every
 *     status, all 1,755 payouts are stored-balance settlements. "No bank
 *     payouts" is a limit of the API, NOT evidence the money stayed put;
 *   * not the books -- a sweep coded to GL 1040 would be read as a bank-section
 *     deposit and INCREASE the balance it emptied (see below).
 *
 * The RECEIVING side does say so. Plaid now feeds GL 1020, and a Square ACH
 * credit landing there carries Square's fixed originator id, so
 * `squareSweepsSinceAnchor` deducts those transfers as they post. The outflow
 * has moved from re-anchoring to derivation, which is what the earlier version
 * of this file said would happen once GL 1020 existed.
 *
 * Re-anchoring has NOT gone away and must not: it still catches money that left
 * by any route the declared bank account does not see, and it is still what
 * gives an account with no declared destination a correct figure. What changes
 * is its size -- the monthly drift should now be a small residual rather than
 * roughly a month of sweeping. See ../squareDrift.ts, which records it.
 *
 * ── Why the postings provider is STILL deliberately not a step here ──────────
 * The outflow now has a step, but not this one. The instinct is to add
 * `transactionPostings` so that a withdrawal coded to 1040 is picked up -- that
 * is exactly what salesTaxPayable and undistributedTips do, and the GL 2310
 * lesson says never ship one half of a movement. It is wrong here, for a
 * mechanical reason that the third step carefully does not run into.
 *
 * GL 1040's statement section is "bank", and for a bank-section account
 * normalizeSign.ts passes the raw cash direction through UNCHANGED, by design
 * and with a long comment saying so. The Ramp ledger row for a Square-to-bank
 * sweep is a POSITIVE deposit (money into Ramp). Coded to 1040 it would read as
 * +$21,940 of additional Square cash -- the sweep would INCREASE the balance it
 * actually emptied. Getting that right would mean changing normalizeSign.ts,
 * which is shared with the P&L and must not be touched.
 *
 * `squareSweepsSinceAnchor` reads the bank's RAW imported lines instead --
 * never a posting, never normalizeSign -- and negates the total itself. Three
 * steps that are all right; the fourth, backwards one still has no place here.
 *
 * ── The anchor and payout steps go null together ─────────────────────────────
 * Neither of those two returns a number unless the account is linked AND an
 * anchor exists. An anchor with no movement, or movement with no anchor, is a half
 * answer -- the precise failure that reported GL 2310 eightfold high. Returning
 * null from both makes the account read as unsourced, which is true, and the
 * month-end close task then asks for the figure. The sweep step nulls on its
 * own terms as well, and for its own reason -- see its comment.
 */
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import { resolveConnection, recordSyncResult } from "../connections";
import { sumNetPayoutCents } from "@/lib/square/payouts";
import { readBankLines } from "../bankTransactions";
import { totalSquareSweeps } from "../squareSweeps";

interface Anchor {
  /** "YYYY-MM-DD" — the date the verified figure belongs to. */
  asOfDate: string;
  cents: number;
}

/**
 * The most recent operator-verified balance dated on or before `periodEnd`.
 *
 * On or before, not exactly on, deliberately. If nobody has closed July yet,
 * July's balance should still carry forward from June's verified figure plus
 * two months of settlements rather than vanishing -- more drift, but a number
 * with a stated basis. `manualBalance`'s exact-date lookup is the right rule
 * for an account that IS the manual figure; this account only uses the manual
 * figure as a starting point.
 *
 * Reads manual_entries directly rather than through the manualBalance provider
 * because that provider answers a different question (exact date only) and
 * because this one needs the anchor's DATE, which a bare balance cannot carry.
 */
async function findAnchor(ctx: BalanceContext): Promise<Anchor | null> {
  const { data, error } = await ctx.supabase
    .from("manual_entries")
    .select("as_of_date, amount_cents")
    .eq("entry_kind", "balance")
    .eq("chart_of_accounts_id", ctx.coaId)
    .lte("as_of_date", ctx.periodEnd)
    .order("as_of_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { as_of_date: string | null; amount_cents: number | null };
  if (!row.as_of_date || row.amount_cents === null) return null;
  return { asOfDate: row.as_of_date, cents: row.amount_cents };
}

/**
 * Resolves the linked connection and the anchor together, since every step
 * needs both and needs them to agree. Null means "this account is not in a
 * state where a balance can be stated", which every caller turns into a null
 * contribution rather than an exception.
 */
async function resolveBasis(ctx: BalanceContext): Promise<{ connectionId: string; anchor: Anchor } | null> {
  const connection = await resolveConnection(ctx.supabase, ctx.config);
  if (!connection) return null;
  const anchor = await findAnchor(ctx);
  if (!anchor) return null;
  return { connectionId: connection.id, anchor };
}

/**
 * Step 1 — the verified starting point.
 *
 * amount_cents is already stored in the internal sign convention, so an asset
 * balance is already positive and needs no normalization (see manualBalance.ts).
 */
export const squareBalanceAnchor: BalanceProvider = {
  key: "squareBalanceAnchor",
  label: "Verified Square balance",
  kind: "manual",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const basis = await resolveBasis(ctx);
    return basis ? basis.anchor.cents : null;
  },
};

/**
 * Step 2 — everything Square settled in since the anchor.
 *
 * Throws on a failed read rather than returning 0 or null. A read failure means
 * the movement is unknown; contributing 0 would publish a month-old anchor as
 * though it were today's balance, and contributing null would do the same by
 * letting step 1 stand alone. Throwing fails the whole method, which leaves the
 * previously stored balance untouched -- stale but correct.
 */
export const squarePayoutsSinceAnchor: BalanceProvider = {
  key: "squarePayoutsSinceAnchor",
  label: "Square settlements since the verified balance",
  kind: "integration",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const basis = await resolveBasis(ctx);
    if (!basis) return null;

    // The anchor already IS this period end's verified figure; nothing to add.
    // Not merely an optimization -- without it the window would be empty or
    // inverted, and a future re-anchor mid-period would double-count.
    if (basis.anchor.asOfDate >= ctx.periodEnd) return 0;

    try {
      const cents = await sumNetPayoutCents(basis.anchor.asOfDate, ctx.periodEnd);
      await recordSyncResult(ctx.supabase, basis.connectionId, { ok: true });
      return cents;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Record the failure for the Settings health line, but never let the
      // bookkeeping of that failure mask the failure itself.
      await recordSyncResult(ctx.supabase, basis.connectionId, { ok: false, error: message }).catch(() => {});
      throw new Error(`Square payouts read failed: ${message}`);
    }
  },
};

/**
 * Step 3 — money swept out to the bank, recognised from the bank's own feed.
 *
 * The outflow half, and the reason the header above describes it as
 * "currently unobservable" only from Square's side. Square still reports
 * nothing; the receiving bank does. When the method names a
 * `sweepDestinationCoaId` and that account has an imported feed, a Square ACH
 * credit landing there is the same dollar leaving the stored balance, so it is
 * deducted here as it happens rather than being absorbed by the next
 * re-anchor.
 *
 * ── Why this is not the `transactionPostings` step the header rules out ──────
 * The objection there is about SIGN, and it still stands: a sweep coded to 1040
 * would arrive through normalizeSign as a positive bank-section deposit and
 * INCREASE the balance it emptied. This step never goes near postings or
 * normalizeSign. It reads the bank's raw imported lines (rows the books
 * deliberately ignore, see ../bankTransactions.ts), recognises Square as the
 * ACH originator, and negates the total itself. Two steps that are both right
 * became three the same way.
 *
 * ── Null, not zero, whenever there is nothing to look at ─────────────────────
 * No basis, no declared destination, or no feed to read all return null. A zero
 * would assert "we checked and nothing was swept", which is exactly the
 * confident-looking claim built on no evidence that ../squareDrift.ts refuses
 * to write. Null leaves the account reading as it did before the bank feed
 * existed: anchor plus payouts, corrected at close.
 *
 * A feed that IS readable and matched nothing returns a real 0 -- readBankLines
 * already distinguishes those two cases and returns null for the empty window.
 *
 * ── Exact and name-only matches are both deducted ────────────────────────────
 * Same reasoning splitDrift gives: a dollar that arrived is a dollar that
 * arrived, whichever rule recognised it. The two stay separated on the
 * month-end reconciliation row, which is where a reader can see how much of the
 * figure rests on prose rather than on Square's ACH originator id.
 */
export const squareSweepsSinceAnchor: BalanceProvider = {
  key: "squareSweepsSinceAnchor",
  label: "Square transfers out, seen on the bank side",
  kind: "derived",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const basis = await resolveBasis(ctx);
    if (!basis) return null;

    // Mirrors the payouts step: the anchor IS this period end's verified
    // figure, so there is no window and nothing to deduct.
    if (basis.anchor.asOfDate >= ctx.periodEnd) return 0;

    const destination = ctx.config.sweepDestinationCoaId;
    if (typeof destination !== "string" || destination.length === 0) return null;

    // Half-open on the left, the same window the payouts term covers: a sweep
    // dated the anchor day is already reflected in the anchor figure.
    const lines = await readBankLines(ctx.supabase, destination, basis.anchor.asOfDate, ctx.periodEnd);
    if (!lines) return null;

    // Subtracted from zero rather than negated, so a month with no matches
    // contributes +0 and not -0. Both are 0 to arithmetic, but -0 survives into
    // the stored contributions and renders as "-$0.00" in the explainer.
    return 0 - totalSquareSweeps(lines).totalCents;
  },
};

registerProvider(squareBalanceAnchor);
registerProvider(squarePayoutsSinceAnchor);
registerProvider(squareSweepsSinceAnchor);
