// Pure helpers for the Manual Entries amount input (Finance > Transactions >
// Manual Entries). Money is entered as a signed dollar string and stored as
// signed integer cents (see the SIGN CONVENTION note in ./manualEntries.ts).
// Unlike a typical currency input, this one must accept — not clamp or
// reject — a leading "-": contra-accounts and credit-side balances are
// legitimately negative in this codebase's stored convention.

import { formatCurrencyCents } from "@/lib/format";

/**
 * Live-formats a raw amount-input string with thousands separators, keeping
 * a leading "-" and up to two decimal places. Safe to call on every
 * keystroke (mirrors the taproom manual-entries tab's formatWithCommas,
 * extended to preserve a negative sign).
 */
export function formatAmountInput(raw: string): string {
  const negative = raw.trim().startsWith("-");
  const sign = negative ? "-" : "";
  const stripped = raw.replace(/[^0-9.]/g, "");
  if (!stripped) return sign;

  const dotIdx = stripped.indexOf(".");
  if (dotIdx !== -1) {
    const intPart = stripped.slice(0, dotIdx);
    const decPart = stripped.slice(dotIdx + 1, dotIdx + 3);
    const intNum = parseInt(intPart, 10);
    const formattedInt = isNaN(intNum) ? intPart : intNum.toLocaleString("en-US");
    return `${sign}${formattedInt}.${decPart}`;
  }
  const n = parseInt(stripped, 10);
  return `${sign}${isNaN(n) ? stripped : n.toLocaleString("en-US")}`;
}

/**
 * Parses a formatted (or raw) amount-input string into signed integer cents.
 * Returns `null` only when there is no number in the input at all.
 *
 * Zero parses to 0, not to null. It used to map to null so a form could reuse
 * one check for "empty" and "not allowed to be zero" — but zero IS allowed
 * (see the SIGN CONVENTION note in ./manualEntries.ts), and folding a real
 * $0.00 balance in with unparseable junk is what produced the reported "Enter
 * the balance as a number" error on an input that already was one. Callers now
 * have to tell blank apart from unreadable themselves, which is the distinction
 * their error messages needed to make anyway.
 */
export function parseAmountInputCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const negative = trimmed.startsWith("-");
  const digits = trimmed.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = parseFloat(digits);
  if (isNaN(n)) return null;
  const cents = Math.round(n * 100) * (negative ? -1 : 1);
  // `|| 0` collapses negative zero. "-0" is now a parseable input rather than a
  // rejected one, and -0 compares unequal to 0 under Object.is — which is what
  // a strict equality check in a caller or a test would use.
  return cents || 0;
}

/**
 * Renders an amount somebody actually TYPED, as opposed to one a statement
 * computed.
 *
 * ── Why this exists rather than calling formatCurrencyCents ──────────────────
 * `formatCurrencyCents` renders exact zero as the em-dash sentinel, and that is
 * correct where it is used: a profit-and-loss statement full of `$0.00` rows is
 * unreadable, and on a computed line a zero and a nothing really are the same
 * uninteresting fact. It is shared with the verified statements and must not be
 * changed.
 *
 * An entered balance is the opposite case, and it defeated the whole point of
 * allowing zero. Someone counts an empty till, enters 0, and the screen shows
 * them the same em dash it showed before they entered anything -- so the app
 * still says "nothing entered" about a figure a person checked and recorded.
 * Here a zero is the answer, and it has to look different from its absence.
 *
 * Negatives keep the accounting parentheses, because a contra or credit-side
 * balance means the same thing on this screen as on any other.
 */
export function formatEnteredAmountCents(cents: number): string {
  return cents === 0 ? "$0.00" : formatCurrencyCents(cents);
}

/** Whole days spanned by [startDate, endDate], inclusive of both ends. */
export function daysInclusive(startDate: string, endDate: string): number {
  const s = new Date(startDate + "T00:00:00Z").getTime();
  const e = new Date(endDate + "T00:00:00Z").getTime();
  return Math.round((e - s) / 86_400_000) + 1;
}

/** Even per-day split of a (possibly negative) amount across `days` days. */
export function perDayCents(amountCents: number, days: number): number {
  return days > 0 ? Math.round(amountCents / days) : amountCents;
}
