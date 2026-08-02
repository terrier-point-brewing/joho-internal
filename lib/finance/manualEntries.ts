// Manual financial entries — the auditable replacement for the ad hoc
// manual_net_sales_entries rows that used to live under Taproom > Targets.
//
// Two kinds share one table:
//   * "flow"    — a P&L amount for a date RANGE (start_date..end_date).
//   * "balance" — a balance-sheet amount AS OF a month end (as_of_date).
//
// The validators below mirror the `manual_entries_kind_dates` CHECK in
// supabase/migrations/20260904120000_manual_entries.sql so the API can return a
// readable 400 instead of surfacing Postgres error 23514.
//
// SIGN CONVENTION: amountCents is signed and may be NEGATIVE for either kind.
// A negative flow is a legitimate correction; a negative balance is legitimate
// for contra-accounts (e.g. Accumulated Depreciation) and for credit-side
// accounts, which this codebase stores negative. Do not add a positivity check.
//
// ZERO IS ALSO LEGITIMATE, and was rejected here until it blocked GL 1010 Cash
// on Hand -- an account whose whole point is that a person counts a till, and
// which can honestly count nothing. Refusing zero forced that real answer to be
// represented as no answer, which is the exact confusion this codebase's
// "null, not zero" rule exists to prevent: the balance provider returns null
// when no row exists, so an entered 0 and an unentered account were already
// distinguishable, and only the validator was collapsing them. Note the table
// never carried a non-zero CHECK -- see 20260904120000_manual_entries.sql --
// so the comments that claimed this mirrored the database were simply wrong.

export type ManualEntryKind = "flow" | "balance";

export interface ManualEntryRecord {
  id: string;
  entryKind: ManualEntryKind;
  chartOfAccountsId: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  amountCents: number;
  label: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type ManualEntryInput =
  | {
      entryKind: "flow";
      chartOfAccountsId: string;
      startDate: string;
      endDate: string;
      amountCents: number;
      label?: string | null;
      note?: string | null;
    }
  | {
      entryKind: "balance";
      chartOfAccountsId: string;
      asOfDate: string;
      amountCents: number;
      label?: string | null;
      note?: string | null;
    };

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** Untyped view of an input so cross-kind fields can be inspected for presence. */
type LooseInput = {
  entryKind?: unknown;
  chartOfAccountsId?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  asOfDate?: unknown;
  amountCents?: unknown;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const OK: ValidationResult = { ok: true };

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

/** Treat both null and undefined as "field absent". */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Last calendar day of the month containing `date`, as "YYYY-MM-DD".
 * Computed in UTC — the codebase's date helpers are UTC-based throughout and a
 * local-time implementation drifts by a day for negative-offset zones.
 * Idempotent: monthEnd(monthEnd(d)) === monthEnd(d).
 */
export function monthEnd(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Day 0 of month index `month` (0-based) is the last day of month `month` (1-based).
  const last = new Date(Date.UTC(year, month, 0));
  return `${last.getUTCFullYear()}-${pad2(last.getUTCMonth() + 1)}-${pad2(last.getUTCDate())}`;
}

/**
 * Validates a manual entry against the same rules as the DB CHECK constraint,
 * returning the FIRST failure with a message naming the offending field.
 */
export function validateManualEntry(input: ManualEntryInput): ValidationResult {
  const raw = input as LooseInput;

  if (raw.entryKind !== "flow" && raw.entryKind !== "balance") {
    return fail(`entryKind must be "flow" or "balance"`);
  }

  if (typeof raw.chartOfAccountsId !== "string" || raw.chartOfAccountsId.trim() === "") {
    return fail("chartOfAccountsId is required");
  }

  const amount = raw.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    return fail("amountCents must be an integer number of cents");
  }
  // No zero check -- see the SIGN CONVENTION note at the top of this file.

  if (raw.entryKind === "flow") {
    if (!isIsoDate(raw.startDate)) {
      return fail("startDate is required for a flow entry and must be YYYY-MM-DD");
    }
    if (!isIsoDate(raw.endDate)) {
      return fail("endDate is required for a flow entry and must be YYYY-MM-DD");
    }
    if (!isAbsent(raw.asOfDate)) {
      return fail("asOfDate must be empty for a flow entry");
    }
    if (raw.startDate > raw.endDate) {
      return fail("startDate must be on or before endDate");
    }
    return OK;
  }

  if (!isIsoDate(raw.asOfDate)) {
    return fail("asOfDate is required for a balance entry and must be YYYY-MM-DD");
  }
  if (!isAbsent(raw.startDate)) {
    return fail("startDate must be empty for a balance entry");
  }
  if (!isAbsent(raw.endDate)) {
    return fail("endDate must be empty for a balance entry");
  }
  if (raw.asOfDate !== monthEnd(raw.asOfDate)) {
    return fail(`asOfDate must be a month end (e.g. ${monthEnd(raw.asOfDate)})`);
  }
  return OK;
}
