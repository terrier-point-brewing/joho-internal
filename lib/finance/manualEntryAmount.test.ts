import { describe, it, expect } from "vitest";
import { formatAmountInput, parseAmountInputCents, daysInclusive, perDayCents } from "./manualEntryAmount";
import { formatBalanceCents, EM_DASH } from "@/lib/format";

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
 * was written to solve. The distinction is the SURFACE, not the number, so
 * these screens render through `formatBalanceCents` instead.
 *
 * `formatBalanceCents` is specified in lib/format.test.ts. What is pinned here
 * is the join: the number this module's parser produces for "0" has to survive
 * all the way to a figure on screen. Either half alone leaves the feature
 * half-built, which is exactly what shipped.
 */
describe("a saved zero, end to end", () => {
  it("renders as a real figure, never as the em-dash sentinel", () => {
    const saved = parseAmountInputCents("0");
    expect(saved).toBe(0);
    expect(formatBalanceCents(saved)).toBe("$0.00");
    expect(formatBalanceCents(saved)).not.toBe(EM_DASH);
    expect(formatBalanceCents(saved)).not.toContain(EM_DASH);
  });

  it("survives the round trip from a typed \"-0\" too", () => {
    // parseAmountInputCents collapses -0 to 0; the formatter independently
    // refuses to render "-$0.00". Neither may start relying on the other.
    expect(formatBalanceCents(parseAmountInputCents("-0"))).toBe("$0.00");
  });

  it("still shows the sentinel when nothing was entered at all", () => {
    // The distinction the whole change exists to preserve: a blank input
    // parses to null, and null is what a blank on screen is meant to mean.
    expect(parseAmountInputCents("")).toBeNull();
    expect(formatBalanceCents(parseAmountInputCents(""))).toBe(EM_DASH);
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
