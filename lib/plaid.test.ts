import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  balanceToCents,
  isDepository,
  createLinkToken,
  exchangePublicToken,
  getAccountBalances,
  PlaidError,
  type PlaidAccount,
} from "./plaid";

function account(over: Partial<PlaidAccount["balances"]> = {}, type = "depository"): PlaidAccount {
  return {
    account_id: "acc-1",
    name: "Chase Operating",
    official_name: "Chase Business Complete Banking",
    mask: "4321",
    type,
    subtype: "checking",
    balances: {
      current: 12_345.67,
      available: 12_000,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
      ...over,
    },
  };
}

/** Replaces global fetch and records what Plaid was asked. */
function stubFetch(responses: { ok: boolean; body: unknown }[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.ok ? 200 : 400, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

beforeEach(() => {
  process.env.PLAID_CLIENT_ID = "cid";
  process.env.PLAID_SECRET = "sek";
  process.env.PLAID_ENV = "production";
  delete process.env.PLAID_REDIRECT_URI;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PLAID_REDIRECT_URI;
});

describe("balanceToCents", () => {
  it("converts dollars to cents without float drift", () => {
    expect(balanceToCents(account())).toBe(1_234_567);
    expect(balanceToCents(account({ current: 0.1 + 0.2 }))).toBe(30);
  });

  it("prefers current over available", () => {
    // Available nets off holds and pending debits, which have not posted and
    // are not in the ledger either -- using it would open a difference against
    // the books that no reconciliation could explain.
    expect(balanceToCents(account({ current: 500, available: 300 }))).toBe(50_000);
  });

  it("falls back to available only when current is absent", () => {
    expect(balanceToCents(account({ current: null, available: 300 }))).toBe(30_000);
  });

  it("returns null, never zero, when the bank reports neither figure", () => {
    // A false 0 on a bank account is the exact failure this whole feature
    // exists to prevent: it reads as a real, reconciled balance.
    expect(balanceToCents(account({ current: null, available: null }))).toBeNull();
  });

  it("keeps a genuine zero balance as zero", () => {
    expect(balanceToCents(account({ current: 0 }))).toBe(0);
  });

  it("returns null for a non-finite figure rather than NaN cents", () => {
    expect(balanceToCents(account({ current: Number.NaN }))).toBeNull();
  });

  it("handles a negative (overdrawn) balance", () => {
    expect(balanceToCents(account({ current: -250.5 }))).toBe(-25_050);
  });
});

describe("isDepository", () => {
  it("accepts a checking account and rejects a credit card", () => {
    expect(isDepository(account())).toBe(true);
    // A credit account's `current` is the amount OWED, positive. Storing it
    // unchanged on an asset row would show a debt as cash.
    expect(isDepository(account({}, "credit"))).toBe(false);
  });
});

describe("PlaidError", () => {
  it("treats an expired login as needing the operator, not a retry", () => {
    expect(new PlaidError("relink", "ITEM_ERROR", "ITEM_LOGIN_REQUIRED").needsReauth).toBe(true);
    expect(new PlaidError("expiring", "ITEM_ERROR", "PENDING_EXPIRATION").needsReauth).toBe(true);
  });

  it("treats a rate limit or outage as retryable", () => {
    expect(new PlaidError("slow down", "RATE_LIMIT_EXCEEDED", "TRANSACTIONS_LIMIT").needsReauth).toBe(false);
    expect(new PlaidError("bank down", "INSTITUTION_ERROR", "INSTITUTION_DOWN").needsReauth).toBe(false);
  });
});

describe("createLinkToken", () => {
  it("opens Link with Transactions, because Balance cannot initialise one alone", () => {
    const calls = stubFetch([{ ok: true, body: { link_token: "link-1", expiration: "2026-08-01T10:00:00Z" } }]);
    return createLinkToken("user-1").then((result) => {
      expect(result.linkToken).toBe("link-1");
      expect(calls[0].url).toBe("https://production.plaid.com/link/token/create");
      expect(calls[0].body.products).toEqual(["transactions"]);
      expect(calls[0].body.client_id).toBe("cid");
    });
  });

  it("omits redirect_uri when none is configured", async () => {
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    await createLinkToken("user-1");
    expect(calls[0].body).not.toHaveProperty("redirect_uri");
  });

  it("sends redirect_uri when configured, which OAuth banks such as Chase require", async () => {
    process.env.PLAID_REDIRECT_URI = "https://app.terrierpoint.com/settings/finance/bank-connections";
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    await createLinkToken("user-1");
    expect(calls[0].body.redirect_uri).toBe("https://app.terrierpoint.com/settings/finance/bank-connections");
  });

  it("targets the sandbox host when asked to", async () => {
    process.env.PLAID_ENV = "sandbox";
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    await createLinkToken("user-1");
    expect(calls[0].url.startsWith("https://sandbox.plaid.com")).toBe(true);
  });

  it("rejects an unrecognised environment rather than silently using production", async () => {
    process.env.PLAID_ENV = "development"; // retired by Plaid
    stubFetch([{ ok: true, body: {} }]);
    await expect(createLinkToken("user-1")).rejects.toThrow(/PLAID_ENV/);
  });
});

describe("exchangePublicToken", () => {
  it("returns the access token and item id", async () => {
    stubFetch([{ ok: true, body: { access_token: "access-live", item_id: "item-1" } }]);
    expect(await exchangePublicToken("public-1")).toEqual({ accessToken: "access-live", itemId: "item-1" });
  });

  it("surfaces Plaid's own error type and code", async () => {
    stubFetch([
      {
        ok: false,
        body: { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN", error_message: "already used" },
      },
    ]);
    await expect(exchangePublicToken("public-1")).rejects.toMatchObject({
      errorType: "INVALID_INPUT",
      errorCode: "INVALID_PUBLIC_TOKEN",
      message: "already used",
    });
  });
});

describe("getAccountBalances", () => {
  it("passes the per-item access token through and returns the accounts", async () => {
    const calls = stubFetch([{ ok: true, body: { accounts: [account()] } }]);
    const accounts = await getAccountBalances("access-live");
    expect(accounts).toHaveLength(1);
    expect(calls[0].url).toBe("https://production.plaid.com/accounts/balance/get");
    expect(calls[0].body.access_token).toBe("access-live");
  });

  it("returns an empty list rather than undefined when Plaid omits accounts", async () => {
    stubFetch([{ ok: true, body: {} }]);
    expect(await getAccountBalances("access-live")).toEqual([]);
  });

  it("raises a reauth-flagged error when the bank login has expired", async () => {
    stubFetch([
      {
        ok: false,
        body: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" },
      },
    ]);
    await expect(getAccountBalances("access-live")).rejects.toSatisfy(
      (err: unknown) => err instanceof PlaidError && err.needsReauth,
    );
  });
});
