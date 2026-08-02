/**
 * Recognising a Square payout in a bank account's transaction description.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * Square publishes no record of money leaving its stored balance. Verified
 * exhaustively against the live v2 API on 2026-08-01: every one of 1,767
 * payouts is an INFLOW (`destination.type = SQUARE_STORED_BALANCE`), the
 * payout-entry vocabulary contains only CHARGE/REFUND/GIFT_CARD_LOAD_FEE for
 * this merchant, and the only negative payouts are refund days. Moving money
 * off the balance is a banking action with no Connect v2 surface at all.
 *
 * So the outflow can only ever be seen from the RECEIVING side -- the bank
 * account Square pays into. That account is named on the method's setup
 * (`sweepDestinationCoaId`), and this module is how a Square deposit is picked
 * out of its ordinary traffic.
 *
 * ── Why the ACH originator id and nothing else ───────────────────────────────
 * A Square ACH credit arrives with a descriptor like:
 *
 *   ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723
 *   CO ENTRY DESCR:SQ260723 SEC:PPD TRACE#:021000028611043 EED:260723
 *   IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC
 *
 * `ORIG ID` is Square's ACH company identifier: a fixed ten-digit token that is
 * the same on every transfer, from every Square merchant, and is not free text
 * a bank can reformat. That makes it the one part of this string safe to match
 * exactly.
 *
 * Everything else in there is a trap:
 *   * `CO ENTRY DESCR:SQ260723` -- the suffix is the date, so it never repeats.
 *   * `TRACE#` / `TRN` -- per-transaction.
 *   * `DESC DATE` / `EED` -- dates.
 *   * `IND NAME` -- the RECIPIENT, not Square.
 *
 * `ORIG CO NAME:Square Inc` is kept as a fallback because banks vary in how
 * much of the ACH addenda they pass through, and some feeds surface a
 * cleaned-up "Square Inc" counterparty with no ORIG ID at all. It is a fallback
 * and not the primary rule because it is prose: "Square" also appears in
 * unrelated merchant names, which is why it is anchored to the ORIG CO NAME
 * field or to an exact counterparty match rather than searched for loose.
 *
 * ── Deposits only ────────────────────────────────────────────────────────────
 * A Square-originated DEBIT is a chargeback or a reversal, not a payout. Only
 * positive amounts count as a sweep; the caller decides what to do with the
 * rest rather than having them silently folded in.
 */

/** Square's ACH company identifier. Fixed, and the same for every Square merchant. */
export const SQUARE_ACH_ORIGINATOR_ID = "9424300002";

/** Matches `ORIG ID:9424300002`, tolerating spacing around the colon. */
const ORIG_ID = new RegExp(String.raw`ORIG\s*ID\s*:\s*${SQUARE_ACH_ORIGINATOR_ID}\b`, "i");

/** Matches `ORIG CO NAME:Square Inc` -- anchored to the field, never a loose "square". */
const ORIG_CO_NAME = /ORIG\s*CO\s*NAME\s*:\s*Square\s*(Inc|Incorporated)?\b/i;

/** A cleaned-up counterparty some feeds give instead of the raw addenda. */
const BARE_COUNTERPARTY = /^\s*square(\s+inc\.?)?\s*$/i;

/** The fields of a bank line this recogniser is willing to look at. */
export interface BankLine {
  description?: string | null;
  counterpartyName?: string | null;
  amountCents: number;
}

export type SweepMatch =
  /** Square's ACH originator id was present. Exact, and safe to act on. */
  | { matched: true; confidence: "exact" }
  /** Only the originator NAME matched. Right in practice, but prose. */
  | { matched: true; confidence: "name" }
  | { matched: false };

/**
 * Does this bank line look like Square paying money in?
 *
 * Deliberately returns HOW it matched rather than a bare boolean. A reconciler
 * that has to explain a figure to a bookkeeper needs to be able to say "matched
 * Square's ACH id" or "matched on the name only" -- and a future caller may
 * reasonably choose to act on the first and merely flag the second.
 */
export function classifySquareSweep(line: BankLine): SweepMatch {
  // A Square-originated debit is a chargeback or a reversal, not a payout.
  if (line.amountCents <= 0) return { matched: false };

  const confidence = matchSquareOriginator(line.description, line.counterpartyName);
  return confidence ? { matched: true, confidence } : { matched: false };
}

/**
 * Is Square the ORIGINATOR of this line, ignoring amount and direction?
 *
 * Split out of classifySquareSweep so the identity question can be asked
 * without the money question. The sweep total needs both -- a debit from Square
 * is a chargeback, not a payout, so it must not count. But deciding whether a
 * COUNTERPARTY is Square (counterpartyClaims.ts, which is looking at a name and
 * has no single amount to speak of) needs only the identity half, and passing a
 * sentinel amount in to get at it would be a lie that later reads as a rule.
 *
 * Null means not Square. Everything about which rule matched, and why the
 * cleaned-up counterparty is checked separately from the descriptor, is in the
 * file header.
 */
export function matchSquareOriginator(
  description?: string | null,
  counterpartyName?: string | null,
): "exact" | "name" | null {
  const haystack = `${description ?? ""} ${counterpartyName ?? ""}`;

  if (ORIG_ID.test(haystack)) return "exact";
  if (ORIG_CO_NAME.test(haystack)) return "name";
  if (counterpartyName && BARE_COUNTERPARTY.test(counterpartyName)) return "name";
  return null;
}

export interface SweepTotals {
  /** Cents matched on Square's ACH originator id. */
  exactCents: number;
  /** Cents matched on the originator name alone. */
  nameOnlyCents: number;
  /** Every matched line, exact or not. */
  totalCents: number;
  matchedCount: number;
}

/**
 * Totals the Square deposits in a set of bank lines.
 *
 * Splits exact from name-only rather than returning one number, because the two
 * carry different weight in a reconciliation and collapsing them would let a
 * loose match quietly become part of a balance. A caller wanting one figure can
 * add them; a caller wanting to be careful cannot accidentally not notice.
 */
export function totalSquareSweeps(lines: BankLine[]): SweepTotals {
  const totals: SweepTotals = { exactCents: 0, nameOnlyCents: 0, totalCents: 0, matchedCount: 0 };

  for (const line of lines) {
    const result = classifySquareSweep(line);
    if (!result.matched) continue;
    if (result.confidence === "exact") totals.exactCents += line.amountCents;
    else totals.nameOnlyCents += line.amountCents;
    totals.totalCents += line.amountCents;
    totals.matchedCount++;
  }

  return totals;
}
