import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readPlaidBalance } from "./plaidCapture";
import type { ConnectionWithSecrets } from "./connections";
import type { PlaidAccount } from "@/lib/plaid";

function connection(over: Partial<ConnectionWithSecrets> = {}): ConnectionWithSecrets {
  return {
    id: "conn-1",
    provider: "plaid",
    label: "Chase · Operating",
    externalId: "plaid-account-1",
    config: {},
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    credentials: { access_token: "access-live" },
    ...over,
  };
}

function account(over: Partial<PlaidAccount> = {}): PlaidAccount {
  return {
    account_id: "plaid-account-1",
    name: "Chase Operating",
    official_name: null,
    mask: "4321",
    type: "depository",
    subtype: "checking",
    balances: { current: 48_123.55, available: 47_000, iso_currency_code: "USD", unofficial_currency_code: null },
    ...over,
  };
}

function stubBalances(accounts: PlaidAccount[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accounts }) })),
  );
}

beforeEach(() => {
  process.env.PLAID_CLIENT_ID = "cid";
  process.env.PLAID_SECRET = "sek";
  process.env.PLAID_ENV = "production";
});

afterEach(() => vi.unstubAllGlobals());

describe("readPlaidBalance", () => {
  it("returns the linked account's current balance in cents", async () => {
    stubBalances([account()]);
    expect(await readPlaidBalance(connection())).toBe(4_812_355);
  });

  it("picks the account by id, never the first one on the item", async () => {
    // An item can carry a checking and a savings. Taking whichever came first
    // would put the wrong account's money on the general ledger, and would do
    // it silently.
    stubBalances([
      account({ account_id: "savings", balances: { current: 999, available: 999, iso_currency_code: "USD", unofficial_currency_code: null } }),
      account(),
    ]);
    expect(await readPlaidBalance(connection())).toBe(4_812_355);
  });

  it("fails rather than guessing when the linked account is gone", async () => {
    stubBalances([account({ account_id: "some-other-account" })]);
    await expect(readPlaidBalance(connection())).rejects.toThrow(/no longer on this connection/);
  });

  it("refuses a non-USD balance rather than summing it into a dollar balance sheet", async () => {
    // Wrong by whatever the exchange rate happens to be, with nothing on screen
    // to say so. Matches the guard the Ramp provider already makes.
    stubBalances([
      account({ balances: { current: 100, available: 100, iso_currency_code: "CAD", unofficial_currency_code: null } }),
    ]);
    await expect(readPlaidBalance(connection())).rejects.toThrow(/CAD.*only US dollars/);
  });

  it("refuses an account with no ISO currency at all", async () => {
    stubBalances([
      account({ balances: { current: 100, available: 100, iso_currency_code: null, unofficial_currency_code: "BTC" } }),
    ]);
    await expect(readPlaidBalance(connection())).rejects.toThrow(/unrecognised currency/);
  });

  it("refuses a credit account, whose balance is a debt not cash", async () => {
    stubBalances([account({ type: "credit", subtype: "credit card" })]);
    await expect(readPlaidBalance(connection())).rejects.toThrow(/not a bank account/);
  });

  it("asks the operator to reconnect when no credential is stored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(readPlaidBalance(connection({ credentials: {} }))).rejects.toThrow(/reconnect/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails when setup never chose a bank account", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(readPlaidBalance(connection({ externalId: null }))).rejects.toThrow(/no bank account chosen/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when the bank reports no figure at all", async () => {
    // Null, not zero -- the caller records it as a failed read rather than
    // storing a balance of nothing.
    stubBalances([
      account({ balances: { current: null, available: null, iso_currency_code: "USD", unofficial_currency_code: null } }),
    ]);
    expect(await readPlaidBalance(connection())).toBeNull();
  });

  it("lets an expired-login error through with its reauth flag intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error_type: "ITEM_ERROR",
          error_code: "ITEM_LOGIN_REQUIRED",
          error_message: "the login details have changed",
        }),
      })),
    );
    await expect(readPlaidBalance(connection())).rejects.toSatisfy(
      (err: unknown) => (err as { needsReauth?: boolean }).needsReauth === true,
    );
  });
});
