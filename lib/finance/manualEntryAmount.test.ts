import { describe, it, expect } from "vitest";
import {
  formatAmountInput,
  formatEnteredAmountCents,
  parseAmountInputCents,
  daysInclusive,
  perDayCents,
} from "./manualEntryAmount";
import { formatCurrencyCents, EM_DASH } from "@/lib/format";

/**
 * The read half of allowing zero, and the half that was missed.
 *
 * Saving 0 worked -- the row landed in the database with amount_cents = 0 --
 * and every surface then rendered it as the em dash that means "nothing here",
 * because `formatCurrencyCents` maps exact zero to that sentinel. So somebody
 * who counted an empty till and entered 0 saw exactly what they saw before they
 * entered anything, which is the confusion allowing zero was meant to end.
 *
 * `formatCurrencyCents` is right to do that and must not change: it is shared
 * with the verified statements, where a page of $0.00 rows is the problem it
 * was written to solve. The distinction is the SURFACE, not the number.
 */
describe("formatEnteredAmountCents", () => {
  it("renders a stored zero as a real figure, never as the em-dash sentinel", () => {
    expect(formatEnteredAmountCents(0)).toBe("$0.00");
    expect(formatEnteredAmountCents(0)).not.toBe(EM_DASH);
    expect(formatEnteredAmountCents(0)).not.toContain(EM_DASH);
  });

  it("differs from the shared money formatter on exactly one input", () => {
    // Pins the divergence to zero alone. Anything else drifting apart would
    // mean a manual-entries screen quietly disagreeing with the balance sheet
    // about what a number looks like.
    for (const cents of [-125000, -1, 1, 1599, 2042913]) {
      expect(formatEnteredAmountCents(cents), String(cents)).toBe(formatCurrencyCents(cents));
    }
    expect(formatEnteredAmountCents(0)).not.toBe(formatCurrencyCents(0));
  });

  it("keeps accounting parentheses on a negative balance", () => {
    // Contra-accounts and credit-side balances are stored negative here, and
    // they mean the same thing on this screen as on any other.
    expect(formatEnteredAmountCents(-125000)).toBe("($1,250.00)");
  });

  it("round-trips what the input parser produced for zero", () => {
    // The two halves have to agree: parse "0" to 0, then render 0 visibly.
    // Either one alone leaves the feature half-built, which is what shipped.
    expect(formatEnteredAmountCents(parseAmountInputCents("0")!)).toBe("$0.00");
  });
});

describe("parseAmountInputCents", () => {
  it("parses a plain positive amount", () => {
    expect(parseAmountInputCents("15.99")).toBe(1599);
  });

  it("parses a negative amount", () => {
    expect(parseAmountInputCents("-1250.00")).toBe(-125000);
  });

  it("ignores thousands separators", () => {
    expect(parseAmountInputCents("1,234.56")).toBe(123456);
    expect(parseAmountInputCents("-1,234.56")).toBe(-123456);
  });

  it("rounds partial cents", () => {
    expect(parseAmountInputCents("1.129")).toBe(113);
  });

  it("parses zero as a real amount, not as invalid", () => {
    // Zero used to map to null so a form could reuse one check for "blank" and
    // "not allowed to be zero". Zero IS allowed (see the sign-convention note
    // in manualEntries.ts) — a counted-and-empty cash tin is a real balance —
    // and collapsing it into the unparseable case is what produced the "Enter
    // the balance as a number" error on an input that already was one.
    expect(parseAmountInputCents("0")).toBe(0);
    expect(parseAmountInputCents("0.00")).toBe(0);
    // Object.is distinguishes -0 from 0, so the sign has to be collapsed or a
    // strict equality check in a caller would fail on a legitimate input.
    expect(Object.is(parseAmountInputCents("-0"), 0)).toBe(true);
    expect(parseAmountInputCents("-0.00")).toBe(0);
  });

  it("returns null for empty/unparseable input", () => {
    expect(parseAmountInputCents("")).toBeNull();
    expect(parseAmountInputCents("   ")).toBeNull();
    expect(parseAmountInputCents("-")).toBeNull();
    expect(parseAmountInputCents("abc")).toBeNull();
  });

  it("treats an integer with no decimal as whole dollars", () => {
    expect(parseAmountInputCents("500")).toBe(50000);
  });
});

describe("formatAmountInput", () => {
  it("adds thousands separators", () => {
    expect(formatAmountInput("1234")).toBe("1,234");
    expect(formatAmountInput("1234567.89")).toBe("1,234,567.89");
  });

  it("preserves a leading negative sign", () => {
    expect(formatAmountInput("-1234.5")).toBe("-1,234.5");
    expect(formatAmountInput("-")).toBe("-");
  });

  it("truncates to two decimal places while typing", () => {
    expect(formatAmountInput("12.345")).toBe("12.34");
  });

  it("returns empty string for empty input", () => {
    expect(formatAmountInput("")).toBe("");
  });
});

describe("daysInclusive", () => {
  it("counts a single day as 1", () => {
    expect(daysInclusive("2026-01-15", "2026-01-15")).toBe(1);
  });

  it("counts a full month inclusive of both ends", () => {
    expect(daysInclusive("2026-01-01", "2026-01-31")).toBe(31);
  });

  it("handles a range spanning a month boundary", () => {
    expect(daysInclusive("2026-01-30", "2026-02-02")).toBe(4);
  });
});

describe("perDayCents", () => {
  it("splits evenly across days", () => {
    expect(perDayCents(10000, 4)).toBe(2500);
  });

  it("rounds a non-even split", () => {
    expect(perDayCents(10000, 3)).toBe(3333);
  });

  it("carries the sign of a negative amount", () => {
    expect(perDayCents(-10000, 4)).toBe(-2500);
  });

  it("falls back to the raw amount when days is 0", () => {
    expect(perDayCents(500, 0)).toBe(500);
  });
});
