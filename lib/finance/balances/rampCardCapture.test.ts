/**
 * The nightly reading that gives a month end something to look up later.
 *
 * Thin by design -- it delegates the read, and with it the sign flip, to the
 * provider -- so what is defended here is the contract captureDailyBalances
 * relies on: a figure it can store, or a THROW carrying a sentence an operator
 * can act on. Returning null would be recorded as the generic "the source
 * returned no balance", which tells nobody anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectionWithSecrets } from "./connections";

const getRampCardBalance = vi.fn();
vi.mock("@/lib/ramp", () => ({
  getRampCardBalance: (...args: unknown[]) => getRampCardBalance(...args),
}));

import { captureRampCardBalance } from "./rampCardCapture";

const CONNECTION = {
  id: "conn-1",
  provider: "rampCard",
  label: "Terrier Point Brewing cards",
  externalId: "ramp-business-1",
  config: {},
  status: "active",
  lastSyncedAt: null,
  lastError: null,
  credentials: {},
} as unknown as ConnectionWithSecrets;

beforeEach(() => vi.clearAllMocks());

describe("captureRampCardBalance", () => {
  it("records the amount owed as a negative liability", async () => {
    getRampCardBalance.mockResolvedValue({
      settled_cents: 3_081_39,
      including_pending_cents: 3_206_24,
      currency_code: "USD",
    });

    // Stored in the same internal convention the provider reads back out. If
    // these two ever disagreed about the sign, every closed month would be
    // wrong by twice the balance and nothing would say so.
    expect(await captureRampCardBalance(CONNECTION)).toBe(-3_081_39);
  });

  it("throws a sentence an operator can act on when Ramp refuses", async () => {
    getRampCardBalance.mockRejectedValue(new Error("Ramp card balance: HTTP 401"));

    await expect(captureRampCardBalance(CONNECTION)).rejects.toThrow("HTTP 401");
  });

  it("refuses a non-USD balance rather than capturing it", async () => {
    getRampCardBalance.mockResolvedValue({
      settled_cents: 100,
      including_pending_cents: 100,
      currency_code: "CAD",
    });

    await expect(captureRampCardBalance(CONNECTION)).rejects.toThrow("CAD");
  });

  it("throws rather than reading a connection that names no Ramp business", async () => {
    await expect(
      captureRampCardBalance({ ...CONNECTION, externalId: null } as ConnectionWithSecrets),
    ).rejects.toThrow();
    expect(getRampCardBalance).not.toHaveBeenCalled();
  });
});
