// `readRampBalance` is the function BOTH the monthly snapshot and the
// connect-time check call. Its whole value is that the two cannot drift, so
// these assert the rules that must hold identically for both callers.
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

const PERIOD_END = "2026-07-31";
const conn = { externalId: "ramp-acct-1" };

function day(date: string, cents: number, currency = "USD") {
  return { date, balance_cents: cents, currency_code: currency };
}

beforeEach(() => vi.clearAllMocks());

describe("readRampBalance", () => {
  it("returns the balance dated exactly on the period end", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-30", 1), day(PERIOD_END, 4_205_37)]);

    expect(await readRampBalance(conn, PERIOD_END)).toEqual({ ok: true, balanceCents: 4_205_37 });
  });

  it("fails rather than falling back to the nearest earlier day", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-30", 999_99)]);

    expect(await readRampBalance(conn, PERIOD_END)).toEqual({
      ok: false,
      reason: `Ramp reported no balance for ${PERIOD_END}.`,
    });
  });

  it("fails on a non-USD balance", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, 1, "CAD")]);

    const result = await readRampBalance(conn, PERIOD_END);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("CAD");
  });

  it("fails without calling Ramp when no account is chosen", async () => {
    const result = await readRampBalance({ externalId: null }, PERIOD_END);

    expect(result.ok).toBe(false);
    expect(getRampAccountBalanceHistory).not.toHaveBeenCalled();
  });

  it("turns a thrown API error into a reason instead of propagating it", async () => {
    getRampAccountBalanceHistory.mockRejectedValue(new Error("Ramp balance history: HTTP 503"));

    expect(await readRampBalance(conn, PERIOD_END)).toEqual({
      ok: false,
      reason: "Ramp balance history: HTTP 503",
    });
  });

  it("asks for a window ending on the period end", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([]);

    await readRampBalance(conn, PERIOD_END);

    expect(getRampAccountBalanceHistory).toHaveBeenCalledWith("ramp-acct-1", "2026-07-25", PERIOD_END);
  });
});
