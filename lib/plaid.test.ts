import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  balanceToCents,
  isDepository,
  createLinkToken,
  exchangePublicToken,
  getAccountBalances,
  syncTransactions,
  transactionAmountToCents,
  isSyncMutationError,
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

  it("asks for the maximum transaction history, because this cannot be redone later", () => {
    // Plaid decides how far back to pull when the ITEM is created, and defaults
    // to 90 days. Linking without this and wanting a year afterwards means the
    // history is simply not there -- the same irreversible loss as a missed
    // daily balance capture. 730 is Plaid's maximum, costs nothing extra, and
    // the bank supplies whatever it actually holds.
    //
    // It bounds GL 1040 too: the Square sweeps are identifiable only from this
    // account's transactions, so this number is how far back that account's
    // drift can ever be explained.
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    return createLinkToken("user-1").then(() => {
      expect(calls[0].body.transactions).toEqual({ days_requested: 730 });
    });
  });

  it("omits redirect_uri when none is configured", async () => {
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    await createLinkToken("user-1");
    expect(calls[0].body).not.toHaveProperty("redirect_uri");
  });

  it("sends redirect_uri when configured, which OAuth banks such as Chase require", async () => {
    process.env.PLAID_REDIRECT_URI = "https://internal.johobrewing.com/settings/finance/balance-sheet-accounts";
    const calls = stubFetch([{ ok: true, body: { link_token: "l", expiration: "e" } }]);
    await createLinkToken("user-1");
    expect(calls[0].body.redirect_uri).toBe("https://internal.johobrewing.com/settings/finance/balance-sheet-accounts");
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

/**
 * ── The sign convention ──────────────────────────────────────────────────────
 * The single most error-prone thing in the Chase import. Plaid reports a DEPOSIT
 * as a NEGATIVE amount on a depository account -- "positive values when money
 * moves out of the account" -- which is the opposite of what everyone assumes.
 *
 * Getting it backwards raises no error anywhere. classifySquareSweep ignores any
 * line whose amount is not positive, on the grounds that a Square-originated
 * debit is a chargeback rather than a payout, so an unflipped feed silently
 * discards every sweep and the reconciliation reports a confident zero
 * explained. Hence these tests rather than a comment.
 */
describe("transactionAmountToCents", () => {
  it("turns Plaid's negative deposit into a POSITIVE amount", () => {
    // A real Square payout of $27,456.35 arrives from Plaid as -27456.35.
    expect(transactionAmountToCents({ amount: -27456.35 })).toBe(2745635);
  });

  it("turns Plaid's positive withdrawal into a NEGATIVE amount", () => {
    expect(transactionAmountToCents({ amount: 1234.56 })).toBe(-123456);
  });

  it("keeps zero as zero rather than negative zero", () => {
    // -0 is not 0 under Object.is, which is what an equality comparison uses.
    expect(Object.is(transactionAmountToCents({ amount: 0 }), 0)).toBe(true);
  });

  it("rounds to whole cents rather than trusting binary floating point", () => {
    expect(transactionAmountToCents({ amount: -0.07 })).toBe(7);
    expect(transactionAmountToCents({ amount: -19.99 })).toBe(1999);
    expect(transactionAmountToCents({ amount: -(0.1 + 0.2) })).toBe(30);
  });

  it("does NOT share a convention with the balance reader, whose sign is already intuitive", () => {
    // Pinned together so a future tidy-up cannot "unify" two conventions that
    // are genuinely different: a Plaid BALANCE is positive for money held, a
    // Plaid TRANSACTION is positive for money leaving.
    expect(balanceToCents(account({ current: 150.25 }))).toBe(15025);
    expect(transactionAmountToCents({ amount: 150.25 })).toBe(-15025);
  });
});

describe("isSyncMutationError", () => {
  it("recognises the mid-pagination mutation Plaid asks callers to restart on", () => {
    const err = new PlaidError("changed", "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    expect(isSyncMutationError(err)).toBe(true);
  });

  it("does not treat an expired credential as a restartable pagination fault", () => {
    // Restarting on this would loop against a bank that will never answer.
    expect(isSyncMutationError(new PlaidError("relink", "ITEM_ERROR", "ITEM_LOGIN_REQUIRED"))).toBe(false);
    expect(isSyncMutationError(new Error("network down"))).toBe(false);
    expect(isSyncMutationError(null)).toBe(false);
  });
});

describe("syncTransactions", () => {
  const page = {
    added: [{ transaction_id: "t1" }],
    modified: [],
    removed: [],
    next_cursor: "cursor-2",
    has_more: false,
  };

  it("omits the cursor entirely on a first sync, which asks for the full history", async () => {
    // Plaid rejects an explicit null, and this is the call that pulls the two
    // years the link token asked for.
    const calls = stubFetch([{ ok: true, body: page }]);
    const result = await syncTransactions("access-live", null);

    expect(calls[0].url).toBe("https://production.plaid.com/transactions/sync");
    expect(calls[0].body).not.toHaveProperty("cursor");
    expect(result).toEqual({
      added: [{ transaction_id: "t1" }],
      modified: [],
      removed: [],
      nextCursor: "cursor-2",
      hasMore: false,
    });
  });

  it("sends a stored cursor so only changes since it come back", async () => {
    const calls = stubFetch([{ ok: true, body: page }]);
    await syncTransactions("access-live", "cursor-1");
    expect(calls[0].body.cursor).toBe("cursor-1");
    expect(calls[0].body.access_token).toBe("access-live");
  });

  it("asks for the original description, which is where the ACH addenda survives", async () => {
    // The Square sweep is recognised from its ACH originator id, and some banks
    // only keep it in original_description. Without this option the exact match
    // degrades to the weaker name rule with nothing to say why.
    const calls = stubFetch([{ ok: true, body: page }]);
    await syncTransactions("access-live", null);
    expect(calls[0].body.options).toEqual({ include_original_description: true });
  });

  it("returns empty lists rather than undefined when Plaid omits a bucket", async () => {
    stubFetch([{ ok: true, body: { next_cursor: "c", has_more: false } }]);
    expect(await syncTransactions("access-live", "c")).toEqual({
      added: [],
      modified: [],
      removed: [],
      nextCursor: "c",
      hasMore: false,
    });
  });
});
