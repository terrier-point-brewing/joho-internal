// Pure helpers for the Manual Entries amount input (Finance > Transactions >
// Manual Entries). Money is entered as a signed dollar string and stored as
// signed integer cents (see the SIGN CONVENTION note in ./manualEntries.ts).
// Unlike a typical currency input, this one must accept — not clamp or
// reject — a leading "-": contra-accounts and credit-side balances are
// legitimately negative in this codebase's stored convention.

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
 * Parses a formatted (or raw) amount-input string into signed integer
 * cents. Returns `null` for empty/unparseable input AND for zero —
 * `amountCents` must not be zero (matches the DB CHECK / validateManualEntry
 * in ./manualEntries.ts), so treating zero as "invalid" here lets the form
 * reuse one null-check for both cases.
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
  return cents === 0 ? null : cents;
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
