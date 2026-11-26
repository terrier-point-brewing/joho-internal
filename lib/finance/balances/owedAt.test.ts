import { describe, it, expect } from "vitest";
import { billOwedAtFilter, invoiceOwedAtFilter, dayAfterIso } from "./owedAt";

/**
 * The filters are PostgREST strings, so a test that only compared strings would
 * prove nothing about what they select. Each one is evaluated here against rows
 * by a tiny interpreter for exactly the grammar they use -- `col.op.value`,
 * `and(...)`, top-level OR -- so the cases below are the real October 2026 rows
 * and the assertions are about which of them were owed.
 */
type Row = Record<string, string | null>;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function test(term: string, row: Row): boolean {
  if (term.startsWith("and(")) return splitTop(term.slice(4, -1)).every((t) => test(t, row));
  const [col, op, ...rest] = term.split(".");
  const value = rest.join(".");
  const cell = row[col] ?? null;
  if (op === "is") return value === "null" ? cell === null : false;
  if (cell === null) return false; // SQL: a comparison with NULL is not true
  if (op === "eq") return cell === value;
  if (op === "gt") return cell > value;
  if (op === "gte") return cell >= value;
  throw new Error(`unsupported operator ${op}`);
}

const matches = (filter: string, row: Row) => splitTop(filter).some((t) => test(t, row));

describe("invoiceOwedAtFilter", () => {
  const owedAtOct31 = (row: Row) => matches(invoiceOwedAtFilter("2026-10-31"), row);

  it("keeps an invoice in receivables until its money lands, not until the customer pays", () => {
    // Invoice #000076: paid by bank transfer on 30 October, landed 3 November.
    expect(owedAtOct31({ status: "paid", paid_on: "2026-10-30", funds_received_on: "2026-11-03" })).toBe(true);
  });

  it("drops an invoice whose money had landed by the month end", () => {
    // Invoice #000079: paid 23 October, landed 28 October.
    expect(owedAtOct31({ status: "paid", paid_on: "2026-10-23", funds_received_on: "2026-10-28" })).toBe(false);
    expect(owedAtOct31({ status: "paid", paid_on: "2026-10-31", funds_received_on: "2026-10-31" })).toBe(false);
  });

  it("counts an invoice still open, and one paid entirely after the month end", () => {
    expect(owedAtOct31({ status: "open", paid_on: null, funds_received_on: null })).toBe(true);
    expect(owedAtOct31({ status: "paid", paid_on: "2026-11-12", funds_received_on: "2026-11-16" })).toBe(true);
  });

  it("falls back to the day the customer paid when the landing day is unknown", () => {
    expect(owedAtOct31({ status: "paid", paid_on: "2026-11-02", funds_received_on: null })).toBe(true);
    expect(owedAtOct31({ status: "paid", paid_on: "2026-10-30", funds_received_on: null })).toBe(false);
  });

  it("treats a paid invoice with no dates at all as collected, and never counts a void", () => {
    expect(owedAtOct31({ status: "paid", paid_on: null, funds_received_on: null })).toBe(false);
    expect(owedAtOct31({ status: "voided", paid_on: null, funds_received_on: null })).toBe(false);
  });
});

describe("billOwedAtFilter", () => {
  const owedAt = (periodEnd: string, row: Row) => matches(billOwedAtFilter(periodEnd), row);

  it("clears a bill the day Ramp sends the payment, not the day the vendor cashes it", () => {
    // CDP's September rent: check sent 18 September, cashed 6 October. The
    // wallet paid in September, so nothing was owed on the 30th.
    const rent = { payment_sent_on: "2026-09-18", settled_at: "2026-10-06T13:15:02+00:00" };
    expect(owedAt("2026-09-30", rent)).toBe(false);
    expect(owedAt("2026-08-31", rent)).toBe(true);
  });

  it("clears a bill that is sent but still reads unpaid", () => {
    expect(owedAt("2026-11-30", { payment_sent_on: "2026-11-18", settled_at: null })).toBe(false);
  });

  it("keeps a bill whose payment goes out after the month end", () => {
    // RahrBSG, due 5 November: paid by instant transfer that day.
    expect(owedAt("2026-10-31", { payment_sent_on: "2026-11-05", settled_at: "2026-11-05T05:17:52+00:00" })).toBe(true);
  });

  it("dates a card or manually-paid bill from when it was marked paid, as before", () => {
    expect(owedAt("2026-10-31", { payment_sent_on: null, settled_at: "2026-10-14T17:10:02+00:00" })).toBe(false);
    expect(owedAt("2026-10-31", { payment_sent_on: null, settled_at: "2026-11-19T14:30:46+00:00" })).toBe(true);
    // Paid at 14:46 on the 31st is paid IN the month.
    expect(owedAt("2026-10-31", { payment_sent_on: null, settled_at: "2026-10-31T14:46:00+00:00" })).toBe(false);
  });

  it("keeps a bill with no payment at all", () => {
    expect(owedAt("2026-10-31", { payment_sent_on: null, settled_at: null })).toBe(true);
  });
});

describe("dayAfterIso", () => {
  it("rolls over a month and a year end", () => {
    expect(dayAfterIso("2026-01-31")).toBe("2026-02-01T00:00:00.000Z");
    expect(dayAfterIso("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });
});
