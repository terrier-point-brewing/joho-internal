/**
 * Daily bank-balance capture.
 *
 * Plaid's balance endpoint answers only for right now and takes no as-of date,
 * so a month-end balance exists only if something recorded it that day. This is
 * that job. It reads every Plaid-linked balance source and writes one row per
 * account into gl_account_daily_balances; the monthly snapshot then reads the
 * month-end row back out through the plaidBalance provider.
 *
 * ── Why 02:00 UTC ────────────────────────────────────────────────────────────
 * The date recorded is `todayLocalDate()` — the calendar date in the brewery's
 * zone at the instant of the run — and 02:00 UTC is 22:00 EDT / 21:00 EST of
 * the PREVIOUS day. So the run that fires early on 1 September records
 * 31 August, using a balance read late on 31 August. That is the closest a
 * daily job gets to a genuine closing balance, and it holds on both sides of a
 * daylight-saving change, which an hour nearer midnight would not.
 *
 * It also orders the two balance crons correctly without either knowing about
 * the other: balance-close runs at 09:00 UTC and snapshots the most recently
 * ended month, so on 1 September it looks up a 31 August capture that this job
 * wrote seven hours earlier.
 *
 * ── A missed day is a missed month end ───────────────────────────────────────
 * Lookup is exact-date only, deliberately — presenting a nearby day's bank
 * balance as a month-end figure is plausible, undetectable and wrong. So if
 * this job fails on the last day of a month, that month's bank balance reads as
 * unsourced rather than approximated, and the fix is to re-run it the same day.
 * That re-run is exactly what the "Run now" button is for: it records TODAY,
 * because a past day's balance cannot be asked for at any price. Running it a
 * day late does not recover the day that was missed.
 *
 * Slow by nature: /accounts/balance/get is synchronous against the bank and can
 * take 30 seconds per connection. Fine here, never in a page load.
 */
import "@/lib/finance/balances/methods";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureDailyBalances } from "@/lib/finance/balances/dailyCapture";
import { readPlaidBalance } from "@/lib/finance/balances/plaidCapture";
import { todayLocalDate } from "@/lib/utils/datetime";

export async function runBalanceCapture(supabase: SupabaseClient) {
  const asOfDate = todayLocalDate();

  const plaid = await captureDailyBalances(supabase, {
    provider: "plaid",
    asOfDate,
    read: readPlaidBalance,
  });

  // Reported rather than thrown. A connection failing is a fact for the
  // Settings status line and the cron detail, not a reason to mark the whole
  // run failed and lose the captures that did succeed.
  return { asOfDate, plaid };
}
