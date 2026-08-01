/**
 * Integrity checks on the golden capture itself.
 *
 * The fixture is hand-transcribed from a production query, and a transcription
 * error in an equivalence gate is worse than having no gate at all -- it would
 * fail the refactor for a reason that has nothing to do with the refactor, or
 * worse, pass it against wrong numbers. Every invariant that held in the source
 * data is asserted here, so a typo cannot survive.
 */
import { describe, it, expect } from "vitest";
import {
  GOLDEN_BALANCE_SHEET,
  GOLDEN_STEP_KEYS,
  goldenPeriodTotal,
} from "./goldenBalanceSheet";

const PERIODS = Object.keys(GOLDEN_BALANCE_SHEET);

describe("golden balance sheet fixture", () => {
  it("covers the two periods captured in production", () => {
    expect(PERIODS).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("every row's contributions sum exactly to its balance", () => {
    for (const [periodEnd, rows] of Object.entries(GOLDEN_BALANCE_SHEET)) {
      for (const row of rows) {
        const summed = Object.values(row.contributions).reduce((a, b) => a + b, 0);
        expect(
          summed,
          `${periodEnd} ${row.accountNumber} ${row.accountName}`,
        ).toBe(row.balanceCents);
      }
    }
  });

  it("no row carries a zero or empty contribution set", () => {
    // An all-null account must produce NO ROW at all rather than a spurious
    // $0 -- so a zero-contribution row in the capture would mean the snapshot
    // service is already misbehaving and the fixture would enshrine it.
    for (const rows of Object.values(GOLDEN_BALANCE_SHEET)) {
      for (const row of rows) {
        expect(Object.keys(row.contributions).length).toBeGreaterThan(0);
        for (const [key, cents] of Object.entries(row.contributions)) {
          expect(cents, `${row.accountNumber}.${key}`).not.toBe(0);
        }
      }
    }
  });

  it("uses only the declared step keys", () => {
    const allowed = new Set<string>(GOLDEN_STEP_KEYS);
    for (const rows of Object.values(GOLDEN_BALANCE_SHEET)) {
      for (const row of rows) {
        for (const key of Object.keys(row.contributions)) {
          expect(allowed.has(key), `unexpected step key "${key}"`).toBe(true);
        }
      }
    }
  });

  it("has no duplicate account within a period", () => {
    for (const [periodEnd, rows] of Object.entries(GOLDEN_BALANCE_SHEET)) {
      const numbers = rows.map((r) => r.accountNumber);
      expect(new Set(numbers).size, periodEnd).toBe(numbers.length);
    }
  });

  it("marks June frozen and July open, as captured", () => {
    expect(GOLDEN_BALANCE_SHEET["2026-06-30"].every((r) => r.isFrozen)).toBe(true);
    expect(GOLDEN_BALANCE_SHEET["2026-07-31"].every((r) => !r.isFrozen)).toBe(true);
  });

  it("reproduces the out-of-balance totals recorded at capture time", () => {
    // Non-zero on purpose: 39 balance-sheet accounts still have no source, so
    // Assets + Liabilities + Equity cannot yet net to zero. If either figure
    // moves, the capture was re-taken against different data and every
    // downstream parity assertion needs re-basing.
    expect(goldenPeriodTotal("2026-06-30")).toBe(-415_286);
    expect(goldenPeriodTotal("2026-07-31")).toBe(-1_528_479);
  });

  it("preserves the 2310 worked example the explainer panel cites", () => {
    const tips = GOLDEN_BALANCE_SHEET["2026-07-31"].find((r) => r.accountNumber === "2310");
    expect(tips).toBeDefined();
    expect(tips!.contributions.tipAccrual).toBe(-577_257);
    expect(tips!.contributions.transactionPostings).toBe(504_860);
    expect(tips!.balanceCents).toBe(-72_397);
    // The accrual alone overstates the liability by ~8x. This ratio is the
    // reason methods exist; if it ever stops holding, the panel copy is stale.
    expect(Math.abs(tips!.contributions.tipAccrual / tips!.balanceCents)).toBeGreaterThan(7);
  });
});
