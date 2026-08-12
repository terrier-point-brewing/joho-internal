/**
 * What is owed on the Ramp cards. Backs GL 2110 Credit Cards:Ramp Card.
 *
 * The liability twin of rampBalance.ts, and worth reading against it, because
 * the two differ in the two things that matter most.
 *
 * ── 1. Sign ──────────────────────────────────────────────────────────────────
 * A treasury account is an asset and the internal convention stores assets
 * positive, which is already the sign Ramp reports cash in, so that provider
 * passes its figure through untouched. A card is a LIABILITY: GL 2110's
 * statement section is `credit_card`, which normalizeSign.ts holds in
 * NEGATIVE_SECTIONS, so the internal convention for it is negative. Ramp
 * reports the outstanding balance as a positive amount owed, because that is
 * how a card issuer talks, so it is negated here -- exactly the flip
 * providers/accruals.ts makes on the tip and tax liabilities, for exactly the
 * same reason. Left unflipped, a $3,081 debt would read as $3,081 of value and
 * throw the sheet out of balance by twice that, with a perfectly plausible
 * number on screen.
 *
 * ── 2. A month end has to have been written down ─────────────────────────────
 * Ramp's treasury endpoint answers about the PAST, so that provider can re-ask
 * for any month end at any time and needs no capture. The card balance endpoint
 * has no as-of date and no history at all -- see lib/ramp.ts for the two other
 * endpoints that were checked and why neither answers this question. That puts
 * this feed on the Plaid side of the line:
 *
 *   CLOSED month -- read the capture dated EXACTLY on the month end, or return
 *   nothing. Never the nearest earlier day. A 27th-of-the-month card balance
 *   presented as the closing figure is plausible, undetectable, wrong, and
 *   about to be frozen into the close.
 *
 *   OPEN month -- the balance sheet live-computes the current month by asking
 *   for that month's LAST day, so on 12 August it asks for 31 August. No such
 *   balance exists yet or ever could, and demanding one is what made GL 1020
 *   and GL 1030 read as unsourced from the 1st until the close. Ramp is asked
 *   where the card stands right now instead, which is the honest answer to
 *   "what do we owe this month" and claims nothing month-end-labelled.
 *
 * A month that ended before this account was connected therefore reads as
 * unsourced forever. That is correct and not worth working around: nothing
 * recorded the figure at the time, and no endpoint can be asked for it now.
 *
 * ── Never throws ─────────────────────────────────────────────────────────────
 * Ramp being unreachable, mid-setup, or answering in an unexpected shape all
 * return null, so the account reads as unsourced and the rest of the balance
 * sheet still renders. The reason is recorded against the connection instead,
 * where Settings > Balance Sheet Accounts shows it on the account's own row.
 */
import { registerProvider, sharedRead } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import {
  resolveConnection,
  recordSyncResult,
  readDailyBalance,
  readLatestDailyBalance,
} from "../connections";
import { getRampCardBalance } from "@/lib/ramp";
import { todayLocalDate } from "@/lib/utils/datetime";
import { isOpenPeriod, RUNNING_BALANCE_MAX_AGE_DAYS } from "../periods";
import type { CoaAccountRef } from "../../financials/types";

/**
 * The outcome of one read, in the shape all three callers need.
 *
 * `reason` is written to be shown to an operator verbatim on the Settings
 * status line, so it says what is wrong in plain words rather than echoing an
 * HTTP status.
 */
export type RampCardReadResult =
  | { ok: true; owedCents: number }
  | { ok: false; reason: string };

/**
 * What is owed on the Ramp cards right now, in internal-convention cents
 * (negative -- see the sign note above).
 *
 * ── Settled charges, not authorisations ──────────────────────────────────────
 * Ramp publishes both a settled balance and one including pending card
 * authorisations. The settled figure is the one that matches these books:
 * statements here are cash basis and count only CLEARED card transactions (see
 * financials/expenseFilters.ts), so a pending authorisation has no expense
 * behind it yet. Counting it would grow the liability with nothing on the other
 * side of the entry, and the difference would never reconcile to anything.
 *
 * Exported so the daily capture and the connect-time check exercise the EXACT
 * path the balance takes. A check with its own lighter query could pass while
 * the real read fails, which is the one outcome a validation exists to rule out.
 *
 * Touches no database and records nothing -- callers own that, because the
 * provider must swallow a failed status write while the check route surfaces it.
 */
export async function readRampCardBalance(connection: { externalId: string | null }): Promise<RampCardReadResult> {
  if (!connection.externalId) {
    return { ok: false, reason: "No Ramp card account chosen for this connection yet." };
  }

  let balance;
  try {
    balance = await getRampCardBalance();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // A non-USD balance summed into a USD balance sheet would be wrong by
  // whatever the exchange rate happens to be, with nothing on screen to say so.
  // Refusing is the only safe answer until this app handles currency.
  if (balance.currency_code !== "USD") {
    return {
      ok: false,
      reason: `Ramp reports this card in ${balance.currency_code}; only USD balances can be used.`,
    };
  }

  // Subtraction rather than negation: `-0` is equal to 0 everywhere it is
  // compared, but it survives into a label as "-0", and a fully paid card
  // reading "minus nothing owed" looks like a bug in the figures.
  return { ok: true, owedCents: 0 - balance.settled_cents };
}

/**
 * Records a read outcome without ever being able to fail the balance.
 * Connection health is telemetry; a failed status write must not turn a correct
 * balance into a skipped account.
 */
async function note(
  ctx: BalanceContext,
  connectionId: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  try {
    await recordSyncResult(ctx.supabase, connectionId, outcome);
  } catch {
    // Deliberately swallowed. See above.
  }
}

export const rampCardBalance: BalanceProvider = {
  key: "rampCardBalance",
  label: "Ramp card balance",
  kind: "integration",
  appliesTo: (coa: CoaAccountRef) => coa.statementSection === "credit_card",

  async compute(ctx: BalanceContext): Promise<number | null> {
    try {
      const connection = await resolveConnection(ctx.supabase, ctx.config);
      // Not linked yet, or linked to a connection since deleted. Unsourced is
      // the correct visible outcome, not an error and not a zero.
      if (!connection) return null;
      // An operator turning a connection off should stop it contributing, not
      // start it erroring.
      if (connection.status === "disabled") return null;

      const today = todayLocalDate();

      // A month that has ended: the capture written on the day, or nothing.
      if (!isOpenPeriod(ctx.periodEnd, today)) {
        return await readDailyBalance(ctx.supabase, ctx.coaId, ctx.periodEnd);
      }

      // The open month. One card balance exists per Ramp business, so every
      // account on this connection is asking the identical question and the
      // answer is memoized for the run -- the balance sheet computes its
      // accounts concurrently, and without this each one would open its own
      // round trip to Ramp on every page view.
      const result = await sharedRead(ctx, `rampCardBalance:live:${connection.id}`, () =>
        readRampCardBalance(connection),
      );

      if (result.ok) {
        await note(ctx, connection.id, { ok: true });
        return result.owedCents;
      }

      await note(ctx, connection.id, { ok: false, error: result.reason });
      // Ramp is down, mid-setup, or answering oddly. The newest recent capture
      // is a better answer to "where does the card stand this month" than a
      // blank account -- and it is bounded by the same age limit the Plaid feed
      // uses, so a feed that stopped weeks ago goes quiet rather than publishing
      // its last figure forever. The CLOSED-month branch above deliberately
      // gets no such fallback.
      return await readLatestDailyBalance(ctx.supabase, ctx.coaId, today, RUNNING_BALANCE_MAX_AGE_DAYS);
    } catch (err) {
      // Degrade rather than throw. A throw fails the whole METHOD, which skips
      // the account for the run -- correct when a figure is half-computed, but
      // wrong here, where there is one step and no partial sum to protect
      // against. Returning null leaves any previously stored month-end row
      // untouched, so an unreachable database costs the statement nothing.
      console.error("[rampCardBalance] could not resolve a card balance", {
        coaId: ctx.coaId,
        periodEnd: ctx.periodEnd,
        err,
      });
      return null;
    }
  },
};

registerProvider(rampCardBalance);
