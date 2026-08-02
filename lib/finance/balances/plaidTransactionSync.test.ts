/**
 * The import, exercised against a fake Plaid and a fake table.
 *
 * There is no live Plaid item to test against -- PLAID_REDIRECT_URI is unset, so
 * no Chase link can be created yet -- and the migration is deliberately
 * unapplied, so this is where the pagination, the cursor ordering and the sign
 * are actually verified.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const syncTransactions = vi.fn();
vi.mock("@/lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plaid")>("@/lib/plaid");
  return { ...actual, syncTransactions: (...a: unknown[]) => syncTransactions(...a) };
});

import { PlaidError } from "@/lib/plaid";
import {
  toLedgerRow,
  counterpartyNameOf,
  syncConnection,
  CURSOR_KEY,
  PLAID_LEDGER_SOURCE,
  type LedgerRow,
} from "./plaidTransactionSync";
import type { ConnectionWithSecrets } from "./connections";

/** Verbatim from a real Square ACH credit into the business's bank account. */
const SQUARE_DESCRIPTOR =
  "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723 CO ENTRY DESCR:SQ260723 " +
  "SEC:PPD TRACE#:021000028611043 EED:260723 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC";

function txn(over: Record<string, unknown> = {}) {
  return {
    transaction_id: "txn-1",
    account_id: "acct-chase",
    date: "2026-07-23",
    // Plaid's sign: NEGATIVE is money arriving in a depository account.
    amount: -27456.35,
    iso_currency_code: "USD",
    name: "ACH CREDIT",
    original_description: SQUARE_DESCRIPTOR,
    merchant_name: null,
    pending: false,
    ...over,
  } as never;
}

function connection(config: Record<string, unknown> = {}): ConnectionWithSecrets {
  return {
    id: "conn-1",
    provider: "plaid",
    label: "Chase Operating",
    externalId: "acct-chase",
    config,
    status: "active",
    lastSyncedAt: null,
    lastError: null,
    credentials: { access_token: "access-live" },
  };
}

/**
 * A fake admin client recording every write, so the ORDER of writes can be
 * asserted -- which is the property that actually matters here.
 *
 * `priorRows` stands in for coding that already exists on a transaction the feed
 * has seen before; the sync reads it back before writing so a replay does not
 * undo it. `priorError` makes that read fail, which must stop the page rather
 * than let it look like a batch of first-time imports.
 */
function fakeClient(
  opts: { priorRows?: Record<string, unknown>[]; priorError?: string } = {},
) {
  const upserts: LedgerRow[][] = [];
  const deletes: string[][] = [];
  const deleteFilters: string[] = [];
  const priorReads: string[][] = [];
  const cursorWrites: string[] = [];
  const order: string[] = [];

  const supabase = {
    from(table: string) {
      if (table === "integration_connections") {
        return {
          update: (patch: { config: Record<string, unknown> }) => ({
            eq: async () => {
              order.push("cursor");
              cursorWrites.push(patch.config[CURSOR_KEY] as string);
              return { error: null };
            },
          }),
        };
      }
      return {
        select: () => {
          const chain: Record<string, unknown> = {
            eq: () => chain,
            in: async (_col: string, ids: string[]) => {
              order.push("prior");
              priorReads.push(ids);
              if (opts.priorError) return { data: null, error: { message: opts.priorError } };
              return { data: opts.priorRows ?? [], error: null };
            },
          };
          return chain;
        },
        upsert: async (rows: LedgerRow[]) => {
          order.push("rows");
          upserts.push(rows);
          return { error: null };
        },
        delete: () => {
          const chain: Record<string, unknown> = {
            eq: (...a: unknown[]) => { deleteFilters.push(a.join("=")); return chain; },
            in: async (_col: string, ids: string[]) => {
              order.push("delete");
              deletes.push(ids);
              return { error: null };
            },
          };
          return chain;
        },
      };
    },
  } as never;

  return { supabase, upserts, deletes, deleteFilters, priorReads, cursorWrites, order };
}

beforeEach(() => {
  syncTransactions.mockReset();
});

describe("counterpartyNameOf", () => {
  it("prefers Plaid's enrichment, which names the ACH originator", () => {
    expect(counterpartyNameOf(txn({ counterparties: [{ name: "Square Inc" }], merchant_name: "Chase" }))).toBe(
      "Square Inc",
    );
  });

  it("falls back to the merchant when there is no enrichment", () => {
    expect(counterpartyNameOf(txn({ merchant_name: "Square" }))).toBe("Square");
  });

  it("is null rather than blank when neither is present", () => {
    // A blank string would satisfy the sweep matcher's "is there a counterparty"
    // check and then match nothing, which reads as a considered negative.
    expect(counterpartyNameOf(txn())).toBeNull();
    expect(counterpartyNameOf(txn({ counterparties: [{ name: "  " }], merchant_name: "" }))).toBeNull();
  });
});

describe("toLedgerRow", () => {
  it("stores an inbound Square payout as a POSITIVE amount", () => {
    // The whole feature turns on this. classifySquareSweep ignores anything not
    // positive, so an unflipped sign means every sweep is discarded silently --
    // and it is also this ledger's own documented convention, inflow positive.
    expect(toLedgerRow(connection(), txn()).amount_cents).toBe(2745635);
  });

  it("stores an outbound payment as a NEGATIVE amount", () => {
    expect(toLedgerRow(connection(), txn({ amount: 812.4 })).amount_cents).toBe(-81240);
  });

  it("keeps the whole Plaid object, because the descriptor's field varies by bank", () => {
    const row = toLedgerRow(connection(), txn());
    expect(row.raw).toMatchObject({ original_description: SQUARE_DESCRIPTOR });
    expect(row.original_description).toBe(SQUARE_DESCRIPTOR);
  });

  it("carries the account id, so another account on the same link stays separate", () => {
    expect(toLedgerRow(connection(), txn({ account_id: "acct-savings" })).external_account_id).toBe("acct-savings");
  });

  it("records a pending transaction as pending rather than dropping it", () => {
    expect(toLedgerRow(connection(), txn({ pending: true })).pending).toBe(true);
  });

  it("tags the row with its source, which is what keeps it apart from Ramp's", () => {
    expect(toLedgerRow(connection(), txn()).source).toBe(PLAID_LEDGER_SOURCE);
    expect(PLAID_LEDGER_SOURCE).toBe("plaid");
  });

  /**
   * ── The safety property ────────────────────────────────────────────────────
   * ramp_bank_ledger feeds the balance sheet, the profit and loss, the cash-flow
   * statement and the transactions grid, all of which are verified and in
   * production use. A Chase row reaching that aggregation would change reported
   * figures across up to two years of imported history, silently.
   *
   * Three INDEPENDENT properties keep it out, and each is asserted separately
   * rather than as one object comparison, so a future edit that removes one of
   * them fails a test that names what it was for.
   */
  describe("keeps the row out of the general ledger", () => {
    it("is imported with the inclusion gate closed", () => {
      // The explicit switch. transactionPostings, fetchSources, the bank-ledger
      // grid and autoMapBankLedger all filter on it.
      expect(toLedgerRow(connection(), txn()).include_in_gl).toBe(false);
    });

    it("is coded to no account, which the balance-sheet reader matches on", () => {
      const row = toLedgerRow(connection(), txn());
      expect(row.chart_of_accounts_id).toBeNull();
      expect(row.mapping_source).toBe("unmapped");
    });

    it("does not affect the profit and loss, which the statement reader filters on", () => {
      expect(toLedgerRow(connection(), txn()).affects_pl).toBe(false);
    });

    it("does not classify the movement, because the feed says nothing about intent", () => {
      // 'deposit' would be a guess dressed as a fact. The one classification
      // that matters -- is this a Square sweep -- is made from the descriptor by
      // squareSweeps.ts, not inferred from the amount's direction here.
      expect(toLedgerRow(connection(), txn()).flow_type).toBe("unclassified");
    });
  });
});

describe("syncConnection", () => {
  it("walks every page and writes the rows", async () => {
    syncTransactions
      .mockResolvedValueOnce({ added: [txn()], modified: [], removed: [], nextCursor: "c1", hasMore: true })
      .mockResolvedValueOnce({
        added: [],
        modified: [txn({ transaction_id: "txn-2" })],
        removed: [],
        nextCursor: "c2",
        hasMore: false,
      });

    const client = fakeClient();
    const result = await syncConnection(client.supabase, connection());

    expect(result).toEqual({ upserted: 2, removed: 0, incomplete: false });
    expect(client.cursorWrites).toEqual(["c1", "c2"]);
  });

  it("writes the rows BEFORE persisting the cursor that covers them", async () => {
    // The one ordering that must never invert. A cursor stored ahead of its rows
    // puts the feed permanently past transactions nothing wrote down, and no
    // later run revisits them -- the sweep would simply never be found.
    syncTransactions.mockResolvedValueOnce({
      added: [txn()],
      modified: [],
      removed: [],
      nextCursor: "c1",
      hasMore: false,
    });

    const client = fakeClient();
    await syncConnection(client.supabase, connection());

    expect(client.order).toEqual(["prior", "rows", "cursor"]);
  });

  it("sends the stored cursor, and then each page's own", async () => {
    syncTransactions
      .mockResolvedValueOnce({ added: [], modified: [], removed: [], nextCursor: "c9", hasMore: true })
      .mockResolvedValueOnce({ added: [], modified: [], removed: [], nextCursor: "c10", hasMore: false });

    const client = fakeClient();
    await syncConnection(client.supabase, connection({ [CURSOR_KEY]: "c8" }));

    expect(syncTransactions.mock.calls[0][1]).toBe("c8");
    expect(syncTransactions.mock.calls[1][1]).toBe("c9");
  });

  it("deletes a withdrawn transaction rather than leaving it to be counted", async () => {
    // A reversed deposit left in place would keep explaining a month's drift
    // forever, which is worse than not having imported it at all.
    syncTransactions.mockResolvedValueOnce({
      added: [],
      modified: [],
      removed: [{ transaction_id: "txn-gone" }],
      nextCursor: "c1",
      hasMore: false,
    });

    const client = fakeClient();
    const result = await syncConnection(client.supabase, connection());

    expect(client.deletes).toEqual([["txn-gone"]]);
    expect(result.removed).toBe(1);
    // Scoped to this source. A Ramp row must not be reachable by a Plaid id,
    // however unlikely a collision is -- the ledger is shared now.
    expect(client.deleteFilters).toContain("source=plaid");
  });

  it("restarts from the last PERSISTED cursor when the item mutates mid-pagination", async () => {
    const mutation = new PlaidError("changed", "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    syncTransactions
      .mockResolvedValueOnce({ added: [txn()], modified: [], removed: [], nextCursor: "c1", hasMore: true })
      .mockRejectedValueOnce(mutation)
      .mockResolvedValueOnce({
        added: [txn({ transaction_id: "txn-2" })],
        modified: [],
        removed: [],
        nextCursor: "c2",
        hasMore: false,
      });

    const client = fakeClient();
    const result = await syncConnection(client.supabase, connection({ [CURSOR_KEY]: "c0" }));

    // The retry resumes from c1 -- the cursor whose rows were actually written
    // -- and NOT from c0, which would re-walk work already committed, nor from
    // anything the failed page returned, which describes a state never stored.
    expect(syncTransactions.mock.calls.map((c) => c[1])).toEqual(["c0", "c1", "c1"]);
    expect(result).toEqual({ upserted: 2, removed: 0, incomplete: false });
  });

  it("gives up after repeated mutations rather than looping against a churning item", async () => {
    const mutation = new PlaidError("changed", "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
    syncTransactions.mockRejectedValue(mutation);

    const client = fakeClient();
    await expect(syncConnection(client.supabase, connection())).rejects.toMatchObject({
      errorCode: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
    });
    // The initial attempt plus the two restarts, and then it stops.
    expect(syncTransactions).toHaveBeenCalledTimes(3);
  });

  it("does not retry an expired credential as though it were a pagination fault", async () => {
    syncTransactions.mockRejectedValue(new PlaidError("relink", "ITEM_ERROR", "ITEM_LOGIN_REQUIRED"));

    const client = fakeClient();
    await expect(syncConnection(client.supabase, connection())).rejects.toThrow(/relink/);
    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });

  it("refuses a connection with no stored bank credential", async () => {
    const client = fakeClient();
    const bare = { ...connection(), credentials: {} };
    await expect(syncConnection(client.supabase, bare)).rejects.toThrow(/reconnect/);
    expect(syncTransactions).not.toHaveBeenCalled();
  });

  it("stops at the page bound and reports it, leaving the rest for the next run", async () => {
    // The first sync of two years may not fit one invocation. Because the cursor
    // is persisted per page, stopping is a pause and not a loss.
    syncTransactions.mockResolvedValue({
      added: [txn()],
      modified: [],
      removed: [],
      nextCursor: "c",
      hasMore: true,
    });

    const client = fakeClient();
    const result = await syncConnection(client.supabase, connection());

    expect(result.incomplete).toBe(true);
    expect(client.cursorWrites.length).toBeGreaterThan(0);
  });
});

/**
 * Re-running this feed must not undo somebody's work.
 *
 * The feed replays a transaction as `modified` whenever the bank touches it, and
 * a "Run now" button makes a replay something a person can ask for at any
 * moment, over data that has since been coded by hand. Before
 * preserveOperatorCoding, every replay reset the account, the classification and
 * the general-ledger switch back to the defaults for a transaction nobody had
 * looked at yet -- silently, with no error anywhere.
 */
describe("a re-run keeps what a person decided", () => {
  /** As the row looks after somebody has switched the feed on and coded it. */
  function codedByHand(over: Record<string, unknown> = {}) {
    return {
      source_transaction_id: "txn-1",
      flow_type: "deposit",
      affects_pl: true,
      include_in_gl: true,
      chart_of_accounts_id: "coa-sales",
      mapping_source: "manual",
      ...over,
    };
  }

  it("keeps a hand-picked account when the bank re-sends the transaction", async () => {
    syncTransactions.mockResolvedValueOnce({
      added: [], modified: [txn()], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorRows: [codedByHand()] });
    await syncConnection(client.supabase, connection());

    expect(client.upserts[0][0]).toMatchObject({
      chart_of_accounts_id: "coa-sales",
      mapping_source: "manual",
    });
  });

  it("keeps the general-ledger switch on once somebody has turned it on", async () => {
    // The single most damaging field to reset: it is what every statement reader
    // filters on, so flipping it back to false removes the row from the books
    // without removing the row.
    syncTransactions.mockResolvedValueOnce({
      added: [], modified: [txn()], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorRows: [codedByHand()] });
    await syncConnection(client.supabase, connection());

    expect(client.upserts[0][0].include_in_gl).toBe(true);
  });

  it("keeps a classification the feed itself never produces", async () => {
    syncTransactions.mockResolvedValueOnce({
      added: [], modified: [txn()], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorRows: [codedByHand()] });
    await syncConnection(client.supabase, connection());

    expect(client.upserts[0][0]).toMatchObject({ flow_type: "deposit", affects_pl: true });
  });

  it("still takes the bank's own facts from the fresh transaction", async () => {
    // Preserving a decision must not mean freezing the transaction. What the
    // bank knows -- the amount, the date, the description -- is always the new
    // one, which is the whole reason a `modified` entry is worth writing.
    syncTransactions.mockResolvedValueOnce({
      added: [],
      modified: [txn({ amount: -99.5, name: "ACH CREDIT (corrected)", date: "2026-07-24" })],
      removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorRows: [codedByHand()] });
    await syncConnection(client.supabase, connection());

    expect(client.upserts[0][0]).toMatchObject({
      amount_cents: 9950,
      description: "ACH CREDIT (corrected)",
      transaction_date: "2026-07-24",
    });
  });

  it("still imports a transaction nobody has seen before as excluded and uncoded", async () => {
    // The other half of the promise. A first import must land outside the books,
    // which is what keeps Chase out of the statements until the switch is thrown.
    syncTransactions.mockResolvedValueOnce({
      added: [txn({ transaction_id: "txn-new" })], modified: [], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorRows: [codedByHand()] });
    await syncConnection(client.supabase, connection());

    expect(client.upserts[0][0]).toMatchObject({
      include_in_gl: false,
      chart_of_accounts_id: null,
      mapping_source: "unmapped",
      flow_type: "unclassified",
      affects_pl: false,
    });
  });

  it("looks up only this feed's rows, so a Ramp transaction cannot be read as one of ours", async () => {
    syncTransactions.mockResolvedValueOnce({
      added: [txn()], modified: [], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient();
    await syncConnection(client.supabase, connection());

    expect(client.priorReads[0]).toEqual(["txn-1"]);
  });

  it("stops the page rather than writing over coding it could not read", async () => {
    // Carrying on with nothing read looks exactly like a page of first-time
    // imports, which is the one outcome the read exists to prevent. The cursor
    // has not moved, so the page simply replays on the next run.
    syncTransactions.mockResolvedValueOnce({
      added: [], modified: [txn()], removed: [], nextCursor: "c1", hasMore: false,
    });

    const client = fakeClient({ priorError: "connection reset" });

    await expect(syncConnection(client.supabase, connection())).rejects.toThrow(/existing bank ledger coding/);
    expect(client.upserts).toHaveLength(0);
    expect(client.cursorWrites).toHaveLength(0);
  });
});
