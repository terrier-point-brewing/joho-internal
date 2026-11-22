/**
 * A failing account is shown to a bookkeeper, so the sentence has to name the
 * line of the balance sheet and say what went wrong in words. The raw provider
 * error does neither.
 */
import { describe, it, expect } from "vitest";
import { plainRecalculationError } from "./recalculationLog";

const ID = "93e4a362-1674-4338-a08b-38f927f001d9";
const labels = new Map([[ID, "2410 Gift Card Liabilities"]]);

describe("plainRecalculationError", () => {
  it("names the account and puts a timeout in words", () => {
    const raw = `Method "giftCardLiability" step "giftCardsRedeemed" failed: canceling statement due to statement timeout (account ${ID})`;
    expect(plainRecalculationError(raw, labels)).toBe(
      "2410 Gift Card Liabilities could not be recalculated: the database took too long to answer (a timeout).",
    );
  });

  it("passes an unrecognised cause through rather than guessing", () => {
    const raw = `Method "rampBalance" step "rampWallet" failed: 401 Unauthorized (account ${ID})`;
    expect(plainRecalculationError(raw, labels)).toBe("2410 Gift Card Liabilities could not be recalculated: 401 Unauthorized.");
  });

  it("still reads when the account is not known", () => {
    const raw = `Method "x" step "y" failed: boom (account 00000000-0000-0000-0000-000000000000)`;
    expect(plainRecalculationError(raw, labels)).toBe("An account could not be recalculated: boom.");
  });

  it("copes with an error that names no account at all", () => {
    expect(plainRecalculationError("could not claim the run lock", labels)).toBe(
      "An account could not be recalculated: could not claim the run lock.",
    );
  });
});
