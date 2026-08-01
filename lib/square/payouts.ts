/**
 * Square payouts — the settlement feed behind GL 1040's balance.
 *
 * ── What a payout is HERE, which is not what the Square docs assume ──────────
 * The usual Square arrangement is: card sales settle, then Square batches them
 * out to a linked bank account, and a payout carries `destination.type =
 * BANK_ACCOUNT`. Under that model a payout is money LEAVING Square.
 *
 * That is not what this feed reports. Every one of the 1,755 payouts the API
 * will return -- queried back to 2021, across every location and every status --
 * has `destination.type = SQUARE_STORED_BALANCE`. Card sales settle INTO a
 * Square-held balance. So a payout here is an INFLOW, and summing payouts gives
 * money in, not money out.
 *
 * That inversion is the whole reason this module exists rather than a generic
 * "payouts to bank" reader.
 *
 * ── Money DOES leave for the bank; this feed simply does not show it ─────────
 * Do not read the above as "the balance only ever grows". Square holds a
 * VERIFIED Chase checking account for this merchant (`ListBankAccounts`:
 * routing 028000121, ending 077, creditable and debitable), and transfers out
 * to it genuinely happen. They are absent from `ListPayouts` regardless --
 * moving money off the stored balance is not modelled as a payout at all.
 *
 * So the outflow is INVISIBLE, not ABSENT. Anything built on this module must
 * treat "no bank payouts" as a limit of the feed and never as evidence that the
 * money stayed put.
 *
 * ── Why the payout total is trustworthy on its own ───────────────────────────
 * `amount_money.amount` is already net of everything. Verified against a full
 * month (July 2026): the payout totals equal the sum of their entries' net
 * amounts exactly, and equal gross minus fees exactly --
 *
 *   entries gross  4,332,371
 *   entries fees      64,092
 *   gross - fees   4,268,279  == sum of payout amounts, to the cent
 *
 * Refunds arrive as their own REFUND entries (and, when a day nets negative, as
 * negative payouts), and processing fees are already deducted. So there is no
 * need to fetch payments, refunds and fees separately and net them by hand --
 * which is exactly where a derived balance would otherwise accumulate drift.
 * One number, already reconciled by Square.
 *
 * ── Dates ────────────────────────────────────────────────────────────────────
 * `begin_time`/`end_time` filter on `created_at`, but the date a payout BELONGS
 * to is `arrival_date`. Those are usually the same day and are not guaranteed
 * to be, so the query window is padded and the arrival-date filter is applied
 * here. Filtering on the API's window alone would silently drop a payout that
 * was created on the 31st and arrived on the 1st.
 */
import { squareGetAll } from "./client";

/** Days of slack on the API's created_at window, so an arrival-date boundary payout is never missed. */
const WINDOW_PAD_DAYS = 14;

interface RawPayout {
  id: string;
  status?: string;
  arrival_date?: string;
  created_at?: string;
  location_id?: string;
  amount_money?: { amount?: number; currency_code?: string };
  destination?: { type?: string };
}

interface RawLocation {
  id: string;
  status?: string;
}

export interface SquarePayout {
  id: string;
  status: string;
  /** "YYYY-MM-DD" — the date the money landed, and the date it counts on. */
  arrivalDate: string;
  /** Net cents, already after processing fees and refunds. Negative on a net-refund day. */
  amountCents: number;
  destinationType: string | null;
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toPayout(raw: RawPayout): SquarePayout | null {
  if (!raw.arrival_date) return null;
  return {
    id: raw.id,
    status: raw.status ?? "UNKNOWN",
    arrivalDate: raw.arrival_date,
    amountCents: raw.amount_money?.amount ?? 0,
    destinationType: raw.destination?.type ?? null,
  };
}

/**
 * Every active location.
 *
 * ListPayouts without a `location_id` returns the DEFAULT location's payouts
 * only -- not every location's. A second taproom would therefore silently stop
 * contributing to the Square balance, understating a cash account with no error
 * anywhere. Enumerating locations costs one extra call and removes that.
 */
async function activeLocationIds(): Promise<string[]> {
  const locations = await squareGetAll<RawLocation>("/locations", "locations");
  return locations.filter((l) => l.status !== "INACTIVE").map((l) => l.id);
}

/**
 * Payouts that ARRIVED in `(fromExclusive, toInclusive]`, across every location.
 *
 * `fromExclusive` is exclusive because it is an anchor date: the anchor is the
 * verified balance AT the end of that day, so that day's payouts are already
 * inside it. Counting them again would double them.
 *
 * FAILED payouts are dropped -- money that never moved.
 */
export async function listPayoutsArrivingBetween(
  fromExclusive: string,
  toInclusive: string,
): Promise<SquarePayout[]> {
  if (toInclusive <= fromExclusive) return [];

  const locationIds = await activeLocationIds();
  const params = {
    begin_time: `${shiftDays(fromExclusive, -WINDOW_PAD_DAYS)}T00:00:00Z`,
    end_time: `${shiftDays(toInclusive, WINDOW_PAD_DAYS)}T00:00:00Z`,
    sort_order: "ASC",
  };

  const collected: SquarePayout[] = [];
  const seen = new Set<string>();
  for (const locationId of locationIds) {
    const raw = await squareGetAll<RawPayout>("/payouts", "payouts", { ...params, location_id: locationId });
    for (const item of raw) {
      const payout = toPayout(item);
      if (!payout) continue;
      if (payout.status === "FAILED") continue;
      if (payout.arrivalDate <= fromExclusive || payout.arrivalDate > toInclusive) continue;
      // Belt and braces: a payout should never come back under two locations,
      // but summing a duplicate would overstate cash and be invisible.
      if (seen.has(payout.id)) continue;
      seen.add(payout.id);
      collected.push(payout);
    }
  }

  return collected;
}

/**
 * Net cents Square settled into the balance across `(fromExclusive, toInclusive]`.
 *
 * Returns 0 for a window with no payouts -- a genuine "nothing moved", which is
 * different from "cannot determine". A failure to READ throws, so the caller can
 * keep the previous balance rather than publish an anchor as if it were current.
 */
export async function sumNetPayoutCents(fromExclusive: string, toInclusive: string): Promise<number> {
  const payouts = await listPayoutsArrivingBetween(fromExclusive, toInclusive);
  return payouts.reduce((sum, p) => sum + p.amountCents, 0);
}
