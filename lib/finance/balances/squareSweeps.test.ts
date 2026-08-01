/**
 * The real descriptor is the fixture. Everything else here is a way that
 * matching it loosely would go wrong.
 */
import { describe, it, expect } from "vitest";
import { classifySquareSweep, totalSquareSweeps, SQUARE_ACH_ORIGINATOR_ID } from "./squareSweeps";

/** Verbatim from a real Square ACH credit into the business's bank account. */
const REAL =
  "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723 CO ENTRY DESCR:SQ260723 " +
  "SEC:PPD TRACE#:021000028611043 EED:260723 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC";

const line = (over: Partial<Parameters<typeof classifySquareSweep>[0]> = {}) => ({
  description: REAL,
  counterpartyName: null,
  amountCents: 2745635,
  ...over,
});

describe("classifySquareSweep", () => {
  it("matches the real descriptor on Square's ACH originator id", () => {
    expect(classifySquareSweep(line())).toEqual({ matched: true, confidence: "exact" });
  });

  it("still matches when the bank reformats the spacing around the colon", () => {
    expect(classifySquareSweep(line({ description: "ORIG ID : 9424300002 SOMETHING ELSE" }))).toEqual({
      matched: true,
      confidence: "exact",
    });
  });

  it("falls back to the originator NAME when the id is absent", () => {
    // Some feeds truncate the addenda. The name is right in practice but is
    // prose, so it is reported as a weaker match rather than as the same thing.
    expect(classifySquareSweep(line({ description: "ORIG CO NAME:Square Inc DESC DATE:260723" }))).toEqual({
      matched: true,
      confidence: "name",
    });
  });

  it("matches a feed that gives a cleaned-up counterparty and no addenda", () => {
    expect(classifySquareSweep(line({ description: "Deposit", counterpartyName: "Square Inc" }))).toEqual({
      matched: true,
      confidence: "name",
    });
  });

  it("does NOT match a merchant that merely has 'square' in its name", () => {
    // The reason the name rule is anchored to the ORIG CO NAME field or to an
    // exact counterparty, and never searched for loose. A taproom pays plenty
    // of suppliers with "Square" in the name.
    expect(classifySquareSweep(line({ description: "POS PURCHASE TOWN SQUARE HARDWARE" }))).toEqual({
      matched: false,
    });
    expect(classifySquareSweep(line({ description: "ACH DEBIT SQUARE ONE COFFEE ROASTERS" }))).toEqual({
      matched: false,
    });
  });

  it("does not match a different originator that happens to be an ACH credit", () => {
    expect(
      classifySquareSweep(line({ description: "ORIG CO NAME:Toast Inc ORIG ID:1234567890 SEC:PPD" })),
    ).toEqual({ matched: false });
  });

  it("ignores a Square-originated DEBIT", () => {
    // A chargeback or reversal, not a payout. Counting it as a sweep would
    // overstate what left the Square balance.
    expect(classifySquareSweep(line({ amountCents: -50000 }))).toEqual({ matched: false });
  });

  it("ignores a zero-amount line", () => {
    expect(classifySquareSweep(line({ amountCents: 0 }))).toEqual({ matched: false });
  });

  it("tolerates missing description and counterparty", () => {
    expect(classifySquareSweep({ amountCents: 100 })).toEqual({ matched: false });
    expect(classifySquareSweep({ description: null, counterpartyName: null, amountCents: 100 })).toEqual({
      matched: false,
    });
  });

  it("pins the originator id, which is the whole basis of the exact match", () => {
    expect(SQUARE_ACH_ORIGINATOR_ID).toBe("9424300002");
    expect(REAL).toContain(`ORIG ID:${SQUARE_ACH_ORIGINATOR_ID}`);
  });
});

describe("totalSquareSweeps", () => {
  it("keeps exact and name-only matches apart", () => {
    // Collapsing them would let a prose match silently become part of a
    // balance. A caller that wants one figure can add them; a caller that wants
    // to be careful cannot fail to notice.
    const totals = totalSquareSweeps([
      line({ amountCents: 2745635 }),
      line({ description: "ORIG CO NAME:Square Inc", amountCents: 2052729 }),
      line({ description: "POS PURCHASE TOWN SQUARE HARDWARE", amountCents: 9999 }),
    ]);

    expect(totals).toEqual({
      exactCents: 2745635,
      nameOnlyCents: 2052729,
      totalCents: 4798364,
      matchedCount: 2,
    });
  });

  it("reports zeroes for a period with no Square deposits", () => {
    // The honest answer for GL 1020 today: it has no transaction rows at all,
    // and "nothing matched" must be distinguishable from "nothing was checked"
    // by the caller, not papered over here.
    expect(totalSquareSweeps([])).toEqual({
      exactCents: 0,
      nameOnlyCents: 0,
      totalCents: 0,
      matchedCount: 0,
    });
  });
});
