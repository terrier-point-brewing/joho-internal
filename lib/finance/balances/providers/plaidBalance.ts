/**
 * Bank balance for a Plaid-linked account (GL 1020 Chase Operating).
 *
 * ── This provider does not call Plaid ────────────────────────────────────────
 * That reads as a mistake and is the single most important thing here, so:
 * Plaid's `/accounts/balance/get` answers "what is the balance RIGHT NOW". It
 * takes no as-of date, and Plaid has no historical balance endpoint at any
 * price tier. Calling it from a snapshot of 31 July would return today's
 * balance and store it as July's -- a wrong figure that looks exactly like a
 * right one.
 *
 * So the live read happens once a day in the balance-capture cron, which
 * records each day's figure under the date it represents, and this provider
 * reads that capture back. See ../dailyCapture.ts.
 *
 * ── A closed month and the open month are different questions ────────────────
 * For a month that has ENDED the lookup is exact-date only (readDailyBalance
 * enforces it). If nothing was captured on the month end, this returns null and
 * the account reads as unsourced -- the correct visible outcome. Falling back
 * to the nearest earlier capture would present a stale bank balance as a
 * month-end figure: plausible, undetectable, and wrong.
 *
 * For the OPEN month that rule was not merely strict, it was wrong. The balance
 * sheet live-computes the current month by asking for that month's LAST day, so
 * on 12 August it asks for 31 August -- a date nothing has captured, or ever
 * could. GL 1020 therefore read as unsourced from the 1st of every month until
 * the close, which is most of the time anyone actually looks at it. The open
 * month is now answered with the newest capture within
 * RUNNING_BALANCE_MAX_AGE_DAYS, so a feed that lags a weekend still reports and
 * a feed that stopped weeks ago does not.
 *
 * Sign: a bank account is an asset, and the internal convention stores assets
 * positive. A depository balance from Plaid is already positive (and negative
 * when overdrawn, which is also correct), so nothing is normalised here.
 */
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import { resolveConnection, readDailyBalance, readLatestDailyBalance } from "../connections";
import { isOpenPeriod, RUNNING_BALANCE_MAX_AGE_DAYS } from "../periods";
import { todayLocalDate } from "@/lib/utils/datetime";
import type { CoaAccountRef } from "../../financials/types";

export const plaidBalance: BalanceProvider = {
  key: "plaidBalance",
  label: "Plaid bank balance",
  kind: "integration",
  appliesTo: (coa: CoaAccountRef) => coa.statementSection === "bank",

  async compute(ctx: BalanceContext): Promise<number | null> {
    try {
      // Resolved first so "no bank linked yet" and "linked but nothing captured
      // that day" are separable in the logs, even though both correctly produce
      // a null balance and an unsourced row.
      const connection = await resolveConnection(ctx.supabase, ctx.config);
      if (!connection) return null;

      const today = todayLocalDate();
      return isOpenPeriod(ctx.periodEnd, today)
        ? await readLatestDailyBalance(ctx.supabase, ctx.coaId, today, RUNNING_BALANCE_MAX_AGE_DAYS)
        : await readDailyBalance(ctx.supabase, ctx.coaId, ctx.periodEnd);
    } catch (err) {
      // Degrade rather than throw. A throw fails the whole METHOD, which skips
      // the account for the run -- correct when a figure is half-computed, but
      // wrong here, where there is only one step and no partial sum to protect
      // against. Returning null leaves any previously stored month-end row
      // untouched, so an unreachable database costs the statement nothing.
      console.error("[plaidBalance] could not resolve a captured balance", {
        coaId: ctx.coaId,
        periodEnd: ctx.periodEnd,
        err,
      });
      return null;
    }
  },
};

registerProvider(plaidBalance);
