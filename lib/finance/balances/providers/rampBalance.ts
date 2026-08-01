/**
 * Balance of a Ramp treasury account, read straight from Ramp for the exact
 * month end being snapshotted. Backs GL 1030 Ramp Operating Account.
 *
 * ── Why there is no daily capture here ───────────────────────────────────────
 * Ramp's balance-history endpoint answers about the past, so a month end can be
 * re-asked for at any time. Plaid's cannot, which is why that integration owns
 * gl_account_daily_balances and this one never touches it. Connecting Ramp in
 * September still yields a correct July figure.
 *
 * ── Exact date, never the nearest one ────────────────────────────────────────
 * A window of days is requested but only the row whose date IS the month end is
 * used. Falling back to the closest earlier day would present, say, a 27th-of-
 * the-month balance as the month-end figure: plausible, undetectable and wrong.
 * The window exists purely so an inclusive/exclusive quirk on `end_date` cannot
 * turn a working read into an empty one -- it is never used to substitute a
 * different day's balance. Same rule readDailyBalance encodes for Plaid.
 *
 * ── Sign ─────────────────────────────────────────────────────────────────────
 * A bank account is an asset, and the internal convention stores assets
 * positive, which is the sign Ramp already reports money held in. The value is
 * returned as-is; nothing here touches normalizeSign, which is shared with the
 * P&L.
 *
 * ── Never throws ─────────────────────────────────────────────────────────────
 * Ramp being unreachable, mid-setup, or answering in an unexpected shape all
 * return null so the account reads as unsourced and the rest of the balance
 * sheet still renders. The reason is recorded against the connection instead,
 * where Settings > Balance Sheet Accounts shows it on the account's own row.
 */
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";
import { resolveConnection, recordSyncResult } from "../connections";
import { getRampAccountBalanceHistory } from "@/lib/ramp";

/**
 * How many days before the month end to ask for. Wide enough to survive an
 * exclusive `end_date` bound; the extra rows are discarded unread.
 */
const WINDOW_DAYS = 6;

/** UTC-only date arithmetic — a local-timezone Date would shift the day. */
function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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

export const rampBalance: BalanceProvider = {
  key: "rampBalance",
  label: "Ramp account balance",
  kind: "integration",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const connection = await resolveConnection(ctx.supabase, ctx.config);
    // Not linked yet, or linked to a connection since deleted. Unsourced is the
    // correct visible outcome, not an error and not a zero.
    if (!connection) return null;
    // An operator turning a connection off should stop it contributing, not
    // start it erroring.
    if (connection.status === "disabled") return null;

    const accountId = connection.externalId;
    if (!accountId) {
      await note(ctx, connection.id, { ok: false, error: "No Ramp account chosen for this connection yet." });
      return null;
    }

    try {
      const history = await getRampAccountBalanceHistory(
        accountId,
        daysBefore(ctx.periodEnd, WINDOW_DAYS),
        ctx.periodEnd,
      );

      const onDate = history.find((row) => row.date === ctx.periodEnd);
      if (!onDate) {
        await note(ctx, connection.id, {
          ok: false,
          error: `Ramp reported no balance for ${ctx.periodEnd}.`,
        });
        return null;
      }

      // A non-USD balance summed into a USD balance sheet would be wrong by
      // whatever the exchange rate happens to be, with nothing on screen to say
      // so. Refusing is the only safe answer until this app handles currency.
      if (onDate.currency_code !== "USD") {
        await note(ctx, connection.id, {
          ok: false,
          error: `Ramp reports this account in ${onDate.currency_code}; only USD balances can be used.`,
        });
        return null;
      }

      await note(ctx, connection.id, { ok: true });
      return onDate.balance_cents;
    } catch (err) {
      await note(ctx, connection.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};

registerProvider(rampBalance);
