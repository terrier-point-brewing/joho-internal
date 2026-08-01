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
import { todayLocalDate } from "@/lib/utils/datetime";

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
 * The outcome of one read, in the shape both callers need.
 *
 * `reason` is written to be shown to an operator verbatim on the Settings
 * status line, so it says what is wrong in plain words rather than echoing an
 * HTTP status.
 */
export type RampReadResult =
  | { ok: true; balanceCents: number; asOfDate: string }
  | { ok: false; reason: string };

/**
 * Reads a connected Ramp account's balance for a period.
 *
 * ── Two periods, two different correct answers ───────────────────────────────
 * The balance sheet asks this for both a CLOSED month and the OPEN one, and
 * conflating them is how the account went blank for a whole month at a time.
 *
 * `periodEnd` in the past -- a month that has actually ended. The answer must
 * be the balance dated EXACTLY on it. Substituting a nearby day would present,
 * say, a 27 July figure as the July closing balance: plausible, undetectable,
 * wrong, and about to be frozen into the close.
 *
 * `periodEnd` in the future -- the open month, which buildBalanceSheetFinancials
 * live-computes on every page view by asking for the month's LAST day. On
 * 12 August it asks for 31 August. There is no such balance yet, and demanding
 * one made this account read as unsourced from the 1st to the close. The
 * running balance as at today IS the answer to "where does this account stand
 * this month", and nothing frozen or month-end-labelled is being claimed.
 *
 * Exported so the connect-time check exercises the EXACT path the snapshot
 * takes. A check with its own lighter query could pass while the real read
 * fails, which is the one outcome a validation exists to rule out.
 *
 * Touches no database and records nothing -- callers own that, because the
 * provider must swallow a failed status write while the check route surfaces it.
 */
export async function readRampBalance(
  connection: { externalId: string | null },
  periodEnd: string,
  /** Today's calendar date in the brewery's zone. Passed in, never read here, so this stays testable. */
  today: string,
): Promise<RampReadResult> {
  if (!connection.externalId) {
    return { ok: false, reason: "No Ramp account chosen for this connection yet." };
  }

  // The open month: the period end has not arrived, so report where the
  // account stands now rather than nothing at all.
  const isOpenPeriod = periodEnd > today;
  const windowEnd = isOpenPeriod ? today : periodEnd;

  let history;
  try {
    history = await getRampAccountBalanceHistory(
      connection.externalId,
      daysBefore(windowEnd, WINDOW_DAYS),
      windowEnd,
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let row;
  if (isOpenPeriod) {
    // Latest row at or before today. Ramp can lag a day on weekends and
    // holidays, so the most recent available reading is the running balance.
    row = history
      .filter((r) => r.date <= today)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!row) {
      return { ok: false, reason: `Ramp reported no balance in the days up to ${today}.` };
    }
  } else {
    row = history.find((r) => r.date === periodEnd);
    if (!row) {
      return { ok: false, reason: `Ramp reported no balance for ${periodEnd}.` };
    }
  }

  // A non-USD balance summed into a USD balance sheet would be wrong by
  // whatever the exchange rate happens to be, with nothing on screen to say so.
  // Refusing is the only safe answer until this app handles currency.
  if (row.currency_code !== "USD") {
    return {
      ok: false,
      reason: `Ramp reports this account in ${row.currency_code}; only USD balances can be used.`,
    };
  }

  return { ok: true, balanceCents: row.balance_cents, asOfDate: row.date };
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

    const result = await readRampBalance(connection, ctx.periodEnd, todayLocalDate());

    if (!result.ok) {
      await note(ctx, connection.id, { ok: false, error: result.reason });
      return null;
    }

    await note(ctx, connection.id, { ok: true });
    return result.balanceCents;
  },
};

registerProvider(rampBalance);
