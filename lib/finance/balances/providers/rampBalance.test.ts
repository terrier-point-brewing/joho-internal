// The two behaviours worth defending here are both about what this provider
// refuses to do: it never substitutes a nearby day's balance for the month end,
// and it never throws — an unreachable Ramp has to leave the rest of the
// balance sheet rendering.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const getRampAccountBalanceHistory = vi.fn();
vi.mock("@/lib/ramp", () => ({
  getRampAccountBalanceHistory: (...args: unknown[]) => getRampAccountBalanceHistory(...args),
}));

const resolveConnection = vi.fn();
const recordSyncResult = vi.fn();
vi.mock("../connections", () => ({
  resolveConnection: (...args: unknown[]) => resolveConnection(...args),
  recordSyncResult: (...args: unknown[]) => recordSyncResult(...args),
}));

import { rampBalance } from "./rampBalance";
import type { BalanceContext } from "../registry";

const PERIOD_END = "2026-07-31";

function ctx(config: Record<string, unknown> = { connectionId: "conn-1" }): BalanceContext {
  return {
    supabase: {} as unknown as SupabaseClient as BalanceContext["supabase"],
    coaId: "coa-1030",
    periodEnd: PERIOD_END,
    config,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    provider: "ramp",
    label: "Ramp · Operating",
    externalId: "ramp-acct-1",
    config: {},
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    credentials: {},
    ...overrides,
  };
}

function day(date: string, cents: number, currency = "USD") {
  return { date, balance_cents: cents, currency_code: currency };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveConnection.mockResolvedValue(connection());
  recordSyncResult.mockResolvedValue(undefined);
});

describe("rampBalance", () => {
  it("returns the balance dated exactly on the period end, positive for an asset", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([
      day("2026-07-29", 111_11),
      day(PERIOD_END, 4_205_37),
    ]);

    expect(await rampBalance.compute(ctx())).toBe(4_205_37);
  });

  it("asks Ramp for a window ending on the period end", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, 1)]);

    await rampBalance.compute(ctx());

    // A window rather than a single day so an exclusive end bound cannot turn a
    // working read into an empty one; the extra days are never used as a value.
    expect(getRampAccountBalanceHistory).toHaveBeenCalledWith("ramp-acct-1", "2026-07-25", PERIOD_END);
  });

  it("returns null rather than the nearest earlier day when the period end is missing", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day("2026-07-30", 999_99)]);

    // The whole point. 30 July's balance presented as a July month end is
    // plausible, undetectable and wrong.
    expect(await rampBalance.compute(ctx())).toBeNull();
    expect(recordSyncResult).toHaveBeenCalledWith({}, "conn-1", expect.objectContaining({ ok: false }));
  });

  it("returns null, not zero, when the account has no connection linked yet", async () => {
    resolveConnection.mockResolvedValue(null);

    expect(await rampBalance.compute(ctx({}))).toBeNull();
    expect(getRampAccountBalanceHistory).not.toHaveBeenCalled();
    // Nothing to report against — there is no connection row to record onto.
    expect(recordSyncResult).not.toHaveBeenCalled();
  });

  it("contributes nothing for a disabled connection without reporting an error", async () => {
    resolveConnection.mockResolvedValue(connection({ status: "disabled" }));

    expect(await rampBalance.compute(ctx())).toBeNull();
    expect(getRampAccountBalanceHistory).not.toHaveBeenCalled();
    expect(recordSyncResult).not.toHaveBeenCalled();
  });

  it("returns null when the connection names no Ramp account yet", async () => {
    resolveConnection.mockResolvedValue(connection({ externalId: null }));

    expect(await rampBalance.compute(ctx())).toBeNull();
    expect(getRampAccountBalanceHistory).not.toHaveBeenCalled();
    expect(recordSyncResult).toHaveBeenCalledWith({}, "conn-1", expect.objectContaining({ ok: false }));
  });

  it("refuses a non-USD balance instead of summing it into a USD statement", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, 4_205_37, "CAD")]);

    expect(await rampBalance.compute(ctx())).toBeNull();
    expect(recordSyncResult).toHaveBeenCalledWith(
      {},
      "conn-1",
      expect.objectContaining({ ok: false, error: expect.stringContaining("CAD") }),
    );
  });

  it("returns null instead of throwing when Ramp is unreachable", async () => {
    getRampAccountBalanceHistory.mockRejectedValue(new Error("Ramp balance history: HTTP 503"));

    // A throw would fail the whole method and skip the account; that is the
    // right response to a half-answer, not to a temporarily unreachable API.
    await expect(rampBalance.compute(ctx())).resolves.toBeNull();
    expect(recordSyncResult).toHaveBeenCalledWith(
      {},
      "conn-1",
      expect.objectContaining({ ok: false, error: "Ramp balance history: HTTP 503" }),
    );
  });

  it("records a successful read so Settings can show when it last worked", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, 100)]);

    await rampBalance.compute(ctx());

    expect(recordSyncResult).toHaveBeenCalledWith({}, "conn-1", { ok: true });
  });

  it("still returns the balance when recording the outcome fails", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, 777_00)]);
    recordSyncResult.mockRejectedValue(new Error("status write failed"));

    // Connection health is telemetry. It must not be able to turn a correct
    // balance into a skipped account.
    expect(await rampBalance.compute(ctx())).toBe(777_00);
  });

  it("passes a negative balance through unchanged", async () => {
    getRampAccountBalanceHistory.mockResolvedValue([day(PERIOD_END, -12_50)]);

    // Internal convention stores assets positive; an overdrawn bank account is
    // genuinely negative and must not be flipped or clamped here.
    expect(await rampBalance.compute(ctx())).toBe(-12_50);
  });

  it("is an integration-kind provider", () => {
    expect(rampBalance.kind).toBe("integration");
  });
});
