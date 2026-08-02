import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveCounterpartyClaims, claimKey } from "./counterpartyClaims";

/**
 * A chainable query that records its filters, so one fake can answer the two
 * different reads this module makes of balance_sheet_account_sources — "which
 * accounts use the Square method" and "what feeds the account it named".
 */
function query(answer: (filters: Record<string, unknown>) => unknown) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
    maybeSingle: async () => answer(filters),
    then: (resolve: (v: unknown) => void) => resolve(answer(filters)),
  };
  return chain;
}

const SQUARE_ACCOUNT = { account_number: "1040", account_name: "Cash & Bank Accounts:Square Deposit Account" };

const CHASE_CONNECTION = {
  id: "conn-chase",
  provider: "plaid",
  label: "Chase Operating",
  external_id: "acct-chase",
  config: {},
  status: "active",
  last_synced_at: null,
  last_error: null,
};

function fakeClient(opts: {
  /** config on the squareStoredBalance source row. */
  squareConfig?: Record<string, unknown> | null;
  /** config rows on the account named as the sweep destination. */
  destinationConfig?: Record<string, unknown>[];
  connection?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
  sourcesError?: boolean;
} = {}) {
  return {
    from(table: string) {
      if (table === "balance_sheet_account_sources") {
        return query((filters) => {
          if (opts.sourcesError) return { data: null, error: { message: "no such table" } };
          if (filters.provider_key === "squareStoredBalance") {
            return {
              data: opts.squareConfig === null
                ? []
                : [{ chart_of_accounts_id: "coa-1040", config: opts.squareConfig ?? { sweepDestinationCoaId: "coa-1020" } }],
              error: null,
            };
          }
          return { data: opts.destinationConfig ?? [{ config: { connectionId: "conn-chase" } }], error: null };
        });
      }
      if (table === "integration_connections") {
        return query(() => ({ data: opts.connection === undefined ? CHASE_CONNECTION : opts.connection, error: null }));
      }
      return query(() => ({ data: opts.account === undefined ? SQUARE_ACCOUNT : opts.account, error: null }));
    },
  } as never;
}

const SQUARE_ON_CHASE = { source: "plaid", counterparty_key: "square", counterparty_label: "Square Inc" };
const ERIE_ON_CHASE = { source: "plaid", counterparty_key: "erie", counterparty_label: "Erie Insurance" };
const SQUARE_ON_RAMP = { source: "ramp", counterparty_key: "square", counterparty_label: "Square Inc" };

describe("a balance-sheet calculation claiming its own counterparties", () => {
  it("claims Square on the feed serving the account Square was declared to pay into", async () => {
    const claims = await resolveCounterpartyClaims(fakeClient(), [SQUARE_ON_CHASE, ERIE_ON_CHASE]);

    expect(claims.get(claimKey(SQUARE_ON_CHASE))?.handler).toBe("balance_sheet");
    // The ordinary payee next to it is untouched — a claim is narrow by
    // construction, not a feed-wide switch.
    expect(claims.has(claimKey(ERIE_ON_CHASE))).toBe(false);
  });

  it("names the account doing the work, not the mechanism", async () => {
    // "Handled by a balance sheet calculation" tells an operator nothing they
    // can act on. The GL number is what they can go and look at.
    const claims = await resolveCounterpartyClaims(fakeClient(), [SQUARE_ON_CHASE]);
    expect(claims.get(claimKey(SQUARE_ON_CHASE))?.badge).toBe("Handled by GL 1040 Square Deposit Account");
  });

  it("does not claim the same name on a feed the declaration says nothing about", async () => {
    // (feed, counterparty) is the identity everywhere else in this screen, and
    // a claim has to honour it: Square paying into Chase says nothing about a
    // Square line on the Ramp account.
    const claims = await resolveCounterpartyClaims(fakeClient(), [SQUARE_ON_RAMP]);
    expect(claims.size).toBe(0);
  });
});

describe("what releases a claim", () => {
  it("claims nothing when no sweep destination has been named", async () => {
    // The field is optional on the method. An account that never named one
    // reconciles as it did before the bank feed existed, and its counterparties
    // stay ordinary — which is correct, because nothing in the app knows where
    // that money went either.
    const claims = await resolveCounterpartyClaims(fakeClient({ squareConfig: {} }), [SQUARE_ON_CHASE]);
    expect(claims.size).toBe(0);
  });

  it("claims nothing when the Square method is not in use at all", async () => {
    const claims = await resolveCounterpartyClaims(fakeClient({ squareConfig: null }), [SQUARE_ON_CHASE]);
    expect(claims.size).toBe(0);
  });

  it("claims nothing when the named destination is fed by no bank connection", async () => {
    const claims = await resolveCounterpartyClaims(fakeClient({ destinationConfig: [{ config: {} }] }), [SQUARE_ON_CHASE]);
    expect(claims.size).toBe(0);
  });

  it("claims nothing when the destination's connection is not a bank feed", async () => {
    // A Square connection is a merchant account, not a feed. Claiming a
    // counterparty on a feed that does not exist would make a row read-only
    // for no reason anyone could find.
    const claims = await resolveCounterpartyClaims(
      fakeClient({ connection: { ...CHASE_CONNECTION, provider: "square" } }),
      [SQUARE_ON_CHASE],
    );
    expect(claims.size).toBe(0);
  });

  it("claims nothing when the account behind the claim has been deleted", async () => {
    const claims = await resolveCounterpartyClaims(fakeClient({ account: null }), [SQUARE_ON_CHASE]);
    expect(claims.size).toBe(0);
  });
});

describe("when claim resolution goes wrong", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves to no claims rather than failing the request", async () => {
    // A claim makes a row read-only. If this module breaks, the failure has to
    // be the screen the operator already knows — editable, Square listed as an
    // ordinary payee — and never a settings page that will not load.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding = { from() { throw new Error("connection reset"); } } as never;

    await expect(resolveCounterpartyClaims(exploding, [SQUARE_ON_CHASE])).resolves.toEqual(new Map());
  });

  it("resolves to no claims when the source table cannot be read", async () => {
    const claims = await resolveCounterpartyClaims(fakeClient({ sourcesError: true }), [SQUARE_ON_CHASE]);
    expect(claims.size).toBe(0);
  });

  it("does no work at all for an empty counterparty list", async () => {
    const from = vi.fn();
    await resolveCounterpartyClaims({ from } as never, []);
    expect(from).not.toHaveBeenCalled();
  });
});
