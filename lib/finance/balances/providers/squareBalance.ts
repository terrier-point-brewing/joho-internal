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
 *   balance = last verified balance + everything Square settled in since
 *
 * The money-IN half is exact. Payouts into the Square stored balance are
 * already net of processing fees and refunds, and Square's own totals reconcile
 * to the cent (see lib/square/payouts.ts). So this is not an estimate that
 * happens to be close; the inflow term is Square's own arithmetic.
 *
 * The money-OUT half is real but currently unobservable, and that is the honest
 * reason this design needs an operator.
 *
 * Money DOES move from the Square balance to the bank. Square holds a verified
 * Chase checking account for this merchant (routing 028000121, ending 077,
 * creditable and debitable) and sweeps to it happen. What is missing is any
 * feed that reports them:
 *   * not the payouts feed -- transfers off the stored balance are not modelled
 *     as payouts at all. Queried back to 2021, across every location and every
 *     status, all 1,755 payouts are stored-balance settlements. "No bank
 *     payouts" is a limit of the API, NOT evidence the money stayed put;
 *   * not the books -- GL 1040 carries zero postings of any kind, across every
 *     source the postings provider reads;
 *   * not the bank side -- there is no Chase feed in this system yet. GL 1020
 *     has no rows of any kind, and Plaid owns building it. (The Ramp ledger's
 *     uncoded "Deposit" rows are a different account's traffic and are not
 *     evidence about Square either way.)
 *
 * So the outflow is absorbed by RE-ANCHORING: each month end an operator checks
 * Square and enters the real figure, that figure becomes the new anchor, and
 * the drift is recorded (see ../squareDrift.ts). Drift cannot compound, and the
 * derived calculation only ever has to be right for one month at a time.
 *
 * Expect that drift to be LARGE and negative -- roughly a month of sweeps --
 * not incidental leakage. Until the Chase feed exists there is no way to
 * separate "swept to the bank" from "the derivation is wrong", which is a real
 * limitation of this account and is written down in ../squareDrift.ts rather
 * than glossed. When Plaid lands GL 1020, those inbound transfers become
 * identifiable and the outflow can move from re-anchoring to derivation.
 *
 * ── Why the postings provider is deliberately NOT a step here ────────────────
 * The obvious instinct is to add `transactionPostings` so that a withdrawal
 * coded to 1040 is picked up -- that is exactly what salesTaxPayable and
 * undistributedTips do, and the GL 2310 lesson says never ship one half of a
 * movement. It is wrong here, for a mechanical reason.
 *
 * GL 1040's statement section is "bank", and for a bank-section account
 * normalizeSign.ts passes the raw cash direction through UNCHANGED, by design
 * and with a long comment saying so. The Ramp ledger row for a Square-to-bank
 * sweep is a POSITIVE deposit (money into Ramp). Coded to 1040 it would read as
 * +$21,940 of additional Square cash -- the sweep would INCREASE the balance it
 * actually emptied. Getting that right would mean changing normalizeSign.ts,
 * which is shared with the P&L and must not be touched.
 *
 * Two steps that are both right beats three steps where the third is backwards.
 *
 * ── Both steps go null together ──────────────────────────────────────────────
 * Neither step returns a number unless the account is linked AND an anchor
 * exists. An anchor with no movement, or movement with no anchor, is a half
 * answer -- the precise failure that reported GL 2310 eightfold high. Returning
 * null from both makes the account read as unsourced, which is true, and the
 * month-end close task then asks for the figure.
 */
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import { resolveConnection, recordSyncResult } from "../connections";
import { sumNetPayoutCents } from "@/lib/square/payouts";

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

registerProvider(squareBalanceAnchor);
registerProvider(squarePayoutsSinceAnchor);
