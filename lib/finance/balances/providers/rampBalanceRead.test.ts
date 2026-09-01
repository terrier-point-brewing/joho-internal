// `readRampBalance` is the function the monthly snapshot, the OPEN-month live
// compute and the connect-time check all call. Its whole value is that the
// three cannot drift, so these pin the rules each depends on.
//
// The central distinction: a CLOSED month must be answered exactly or not at
// all, while the OPEN month must be answered with where the account stands
// today. Collapsing the two either freezes a wrong closing balance or leaves
// the account blank on screen for a whole month.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getRampAccountBalanceHistory = vi.fn();
vi.mock("@/lib/ramp", () => ({
  getRampAccountBalanceHistory: (...args: unknown[]) => getRampAccountBalanceHistory(...args),
}));
vi.mock("../connections", () => ({
  resolveConnection: vi.fn(),
  recordSyncResult: vi.fn(),
}));

import { readRampBalance } from "./rampBalance";

const conn = { externalId: "ramp-acct-1" };

function day(date: string, cents: number, currency = "USD") {
  return { date, balance_cents: cents, currency_code: currency };
}

beforeEach(() => vi.clearAllMocks());

describe("readRampBalance — a closed month", () => {
  const PERIOD_END = "2026-07-31";
  const TODAY = "2026-08-12";

  it("returns the balance dated exactly on the period end", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-30", 1), day(PERIOD_END, 4_205_37)]);

    expect(await readRampBalance(conn, PERIOD_END, TODAY)).toEqual({
      ok: true,
      balanceCents: 4_205_37,
      asOfDate: PERIOD_END,
    });
  });

  it("fails rather than falling back to the nearest earlier day", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-30", 999_99)]);

    // This figure is about to be frozen into the close. A 30 July balance
    // labelled as the July closing balance is plausible and wrong.
    expect(await readRampBalance(conn, PERIOD_END, TODAY)).toEqual({
      ok: false,
      reason: `Ramp reported no balance for ${PERIOD_END}.`,
    });
  });

  it("asks Ramp for a window ending on the period end, not on today", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([]);

    await readRampBalance(conn, PERIOD_END, TODAY);

    expect(getRampAccountBalanceHistory).toHaveBeenCalledWith("ramp-acct-1", "2026-07-25", PERIOD_END);
  });
});

describe("readRampBalance — the open month", () => {
  // What buildBalanceSheetFinancials asks for mid-August: the month's last day,
  // which has not happened yet.
  const PERIOD_END = "2026-08-31";
  const TODAY = "2026-08-12";

  it("returns the running balance as at today instead of nothing", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([
      day("2026-08-10", 100_00),
      day("2026-08-12", 350_00),
    ]);

    // Demanding an exact 31 August row is what made this account read as
    // unsourced from the 1st of the month until the close.
    expect(await readRampBalance(conn, PERIOD_END, TODAY)).toEqual({
      ok: true,
      balanceCents: 350_00,
      asOfDate: "2026-08-12",
    });
  });

  it("takes the LATEST available day when Ramp lags over a weekend", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([
      day("2026-08-12", 350_00),
      day("2026-08-09", 100_00),
    ]);

    const result = await readRampBalance(conn, PERIOD_END, TODAY);
    expect(result).toEqual({ ok: true, balanceCents: 350_00, asOfDate: "2026-08-12" });
  });

  it("never reports a balance dated after today", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([
      day("2026-08-12", 350_00),
      day("2026-08-20", 999_99), // shouldn't exist, but must not win if it does
    ]);

    const result = await readRampBalance(conn, PERIOD_END, TODAY);
    expect(result.ok === true && result.asOfDate).toBe("2026-08-12");
  });

  it("asks Ramp for a window ending TODAY, never for a future date", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(TODAY, 1)]);

    await readRampBalance(conn, PERIOD_END, TODAY);

    expect(getRampAccountBalanceHistory).toHaveBeenCalledWith("ramp-acct-1", "2026-08-06", TODAY);
  });

  it("fails clearly when Ramp has nothing in the recent window", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([]);

    expect(await readRampBalance(conn, PERIOD_END, TODAY)).toEqual({
      ok: false,
      reason: `Ramp reported no balance in the days up to ${TODAY}.`,
    });
  });

  it("treats the period end falling on today as still OPEN — the day is running", async () => {
    // Regression (fixed in isOpenPeriod): 31 August read ON 31 August used to
    // demand that day's exact figure, which Ramp only reports once the day is
    // over — so the account read as unsourced for the whole last day of every
    // month. The newest recent day is the honest running balance instead.
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-08-30", 100_00)]);

    const result = await readRampBalance(conn, "2026-08-31", "2026-08-31");
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.balanceCents).toBe(100_00);
  });
});

describe("readRampBalance — rules that hold for either period", () => {
  it("fails on a non-USD balance", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-31", 1, "CAD")]);

    const result = await readRampBalance(conn, "2026-07-31", "2026-08-12");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("CAD");
  });

  it("fails without calling Ramp when no account is chosen", async () => {
    const result = await readRampBalance({ externalId: null }, "2026-07-31", "2026-08-12");

    expect(result.ok).toBe(false);
    expect(getRampAccountBalanceHistory).not.toHaveBeenCalled();
  });

  it("turns a thrown API error into a reason instead of propagating it", async () => {
    getRampAccountBalanceHistory.mockRejectedValue(new Error("Ramp balance history: HTTP 503"));

    expect(await readRampBalance(conn, "2026-07-31", "2026-08-12")).toEqual({
      ok: false,
      reason: "Ramp balance history: HTTP 503",
    });
  });
});
