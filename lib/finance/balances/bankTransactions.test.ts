import { describe, it, expect } from "vitest";
import { toBankLine, readBankLines } from "./bankTransactions";
import { classifySquareSweep } from "./squareSweeps";

/** Verbatim from a real Square ACH credit into the business's bank account. */
const SQUARE_DESCRIPTOR =
  "ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723 CO ENTRY DESCR:SQ260723 " +
  "SEC:PPD TRACE#:021000028611043 EED:260723 IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC";

function row(over: Record<string, unknown> = {}) {
  return {
    amount_cents: 2745635,
    description: "ACH CREDIT",
    original_description: SQUARE_DESCRIPTOR,
    counterparty_name: null,
    ...over,
  } as never;
}

describe("toBankLine", () => {
  it("concatenates every description field rather than choosing one", () => {
    // The descriptor lands in a different field at every institution. Picking
    // one would be a guess, and the wrong guess reads as "no sweeps found"
    // rather than as an error.
    const line = toBankLine(row());
    expect(line.description).toContain("ACH CREDIT");
    expect(line.description).toContain("ORIG ID:9424300002");
  });

  it("produces a line the sweep matcher recognises exactly, end to end", () => {
    expect(classifySquareSweep(toBankLine(row()))).toEqual({ matched: true, confidence: "exact" });
  });

  it("still reaches the matcher when the bank only kept the descriptor in the description", () => {
    const line = toBankLine(row({ description: SQUARE_DESCRIPTOR, original_description: null }));
    expect(classifySquareSweep(line)).toEqual({ matched: true, confidence: "exact" });
  });

  it("passes a cleaned-up counterparty through separately, not merged into the description", () => {
    // The matcher's bare-counterparty rule requires the field to be exactly the
    // sender's name; folding it into the description would defeat that rule.
    const line = toBankLine(row({ description: "Deposit", original_description: null, counterparty_name: "Square Inc" }));
    expect(line.counterpartyName).toBe("Square Inc");
    expect(classifySquareSweep(line)).toEqual({ matched: true, confidence: "name" });
  });

  it("is null rather than an empty string when no description survives", () => {
    const line = toBankLine(row({ description: null, original_description: null }));
    expect(line.description).toBeNull();
  });

  it("carries the amount through unchanged, sign included", () => {
    expect(toBankLine(row({ amount_cents: -81240 })).amountCents).toBe(-81240);
  });
});

/**
 * The read path, against a fake dispatching on table name. Two hops: the GL
 * account names a connection, the connection names the bank account.
 */
/** A chainable query that resolves to `result` whenever it is awaited. */
function query(result: unknown) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gt: () => chain,
    lte: () => chain,
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

function fakeClient(opts: {
  sources?: { config: Record<string, unknown> | null }[];
  connection?: Record<string, unknown> | null;
  transactions?: Record<string, unknown>[];
  transactionsError?: boolean;
}) {
  return {
    from(table: string) {
      if (table === "balance_sheet_account_sources") return query({ data: opts.sources ?? [], error: null });
      if (table === "integration_connections") return query({ data: opts.connection ?? null, error: null });
      return query(
        opts.transactionsError
          ? { data: null, error: { message: "no such table" } }
          : { data: opts.transactions ?? [], error: null },
      );
    },
  } as never;
}

const LINKED_CONNECTION = {
  id: "conn-1",
  provider: "plaid",
  label: "Chase Operating",
  external_id: "acct-chase",
  config: {},
  status: "active",
  last_synced_at: null,
  last_error: null,
};

describe("readBankLines", () => {
  it("returns the account's lines when there is a feed", async () => {
    const supabase = fakeClient({
      sources: [{ config: { connectionId: "conn-1" } }],
      connection: LINKED_CONNECTION,
      transactions: [row()],
    });

    const lines = await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31");
    expect(lines).toHaveLength(1);
    expect(classifySquareSweep(lines![0])).toEqual({ matched: true, confidence: "exact" });
  });

  it("returns null when the account names no connection", async () => {
    // Not an empty list. Null is what tells the reconciler to leave its figures
    // unset rather than record a confident zero swept.
    const supabase = fakeClient({ sources: [{ config: {} }] });
    expect(await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31")).toBeNull();
  });

  it("returns null when the connection has no bank account chosen yet", async () => {
    const supabase = fakeClient({
      sources: [{ config: { connectionId: "conn-1" } }],
      connection: { ...LINKED_CONNECTION, external_id: null },
    });
    expect(await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31")).toBeNull();
  });

  it("returns null for a connection that is not a bank link at all", async () => {
    const supabase = fakeClient({
      sources: [{ config: { connectionId: "conn-1" } }],
      connection: { ...LINKED_CONNECTION, provider: "square" },
    });
    expect(await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31")).toBeNull();
  });

  it("returns null for a window with no imported lines", async () => {
    // The link asks for two years of history, so an operating account with no
    // lines at all for a month means the import has not reached it -- not that
    // the account sat idle. Claiming "nothing was swept" from that would be a
    // finding built on an absent feed.
    const supabase = fakeClient({
      sources: [{ config: { connectionId: "conn-1" } }],
      connection: LINKED_CONNECTION,
      transactions: [],
    });
    expect(await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31")).toBeNull();
  });

  it("returns null rather than throwing when the table cannot be read", async () => {
    // Graceful degradation: an unavailable feed must leave the reconciliation
    // undifferentiated, never break the close.
    const supabase = fakeClient({
      sources: [{ config: { connectionId: "conn-1" } }],
      connection: LINKED_CONNECTION,
      transactionsError: true,
    });
    expect(await readBankLines(supabase, "coa-1020", "2026-06-30", "2026-07-31")).toBeNull();
  });
});
