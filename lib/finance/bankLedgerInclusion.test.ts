/**
 * The first four tests here are the safety gate for this whole feature, not
 * ordinary coverage.
 *
 * The profit and loss, the cash-flow statement, the transactions grid and the
 * balance sheet are verified and in production use, and every one of them reads
 * ramp_bank_ledger through this module. So what has to be proved is not "the
 * rules work" but "no rules means nothing moved": with an empty rule set the
 * query built is the SAME CALL the readers made before this module existed --
 * `.eq("include_in_gl", true)`, not a differently-spelled equivalent -- and the
 * row predicate accepts every row that query can return.
 *
 * The failure modes worth naming: a rule table that does not exist yet (this
 * migration is authored, not applied), one whose grant was never issued, and a
 * read that simply fails. All three resolve to "no rules", because a statement
 * that quietly empties itself is far worse than one that ignores a switch.
 */
import { describe, it, expect } from "vitest";
import {
  buildInclusion,
  counterpartyKeyOf,
  loadBankLedgerInclusion,
  loadRules,
  type GlRule,
  type InclusionFacts,
} from "./bankLedgerInclusion";

/** Records every filter call, so a test can assert on the exact query built. */
function fakeQuery() {
  const calls: string[] = [];
  const chain = {
    calls,
    eq(column: string, value: unknown) { calls.push(`eq(${column},${String(value)})`); return chain; },
    or(filters: string) { calls.push(`or(${filters})`); return chain; },
  };
  return chain;
}

function row(over: Partial<InclusionFacts> = {}): InclusionFacts {
  return { source: "ramp", counterparty_key: "gusto", counterparty_name: "GUSTO", include_in_gl: true, ...over };
}

describe("no rules leaves the readers exactly as they were", () => {
  it("builds the one predicate the readers already carried, and nothing else", () => {
    const q = fakeQuery();
    buildInclusion([]).applyTo(q);
    expect(q.calls).toEqual(["eq(include_in_gl,true)"]);
  });

  it("accepts every row that predicate can return", () => {
    const inclusion = buildInclusion([]);
    expect(inclusion.allows(row())).toBe(true);
    expect(inclusion.allows(row({ source: "plaid", counterparty_name: "Square Inc" }))).toBe(true);
    expect(inclusion.allows(row({ counterparty_key: null, counterparty_name: null }))).toBe(true);
  });

  it("still excludes a row the importer excluded", () => {
    // The gate #333 built is untouched: a rule set that says nothing defers to it.
    expect(buildInclusion([]).allows(row({ source: "plaid", include_in_gl: false }))).toBe(false);
  });
});

describe("a missing or unreadable rule table behaves as no rules", () => {
  it("resolves an error response to no rules rather than an empty statement", async () => {
    const supabase = { from: () => ({ select: async () => ({ data: null, error: { message: 'relation "bank_ledger_gl_rules" does not exist' } }) }) };
    expect(await loadRules(supabase)).toEqual([]);
    const q = fakeQuery();
    (await loadBankLedgerInclusion(supabase)).applyTo(q);
    expect(q.calls).toEqual(["eq(include_in_gl,true)"]);
  });

  it("resolves a thrown read the same way", async () => {
    const supabase = { from: () => ({ select: async () => { throw new Error("network"); } }) };
    expect(await loadRules(supabase)).toEqual([]);
  });

  it("reads once per client, so a forty-account balance sheet makes one query", async () => {
    let reads = 0;
    const supabase = { from: () => ({ select: async () => { reads += 1; return { data: [], error: null }; } }) };
    await Promise.all([loadBankLedgerInclusion(supabase), loadBankLedgerInclusion(supabase)]);
    await loadBankLedgerInclusion(supabase);
    expect(reads).toBe(1);

    // A different client is a different piece of work, so a rule saved between
    // the two is picked up rather than served from a stale cache.
    const other = { from: () => ({ select: async () => { reads += 1; return { data: [], error: null }; } }) };
    await loadBankLedgerInclusion(other);
    expect(reads).toBe(2);
  });
});

function srcRule(source: string, included: boolean): GlRule {
  return { scope: "source", source, counterparty_key: null, included };
}
function cpRule(source: string, key: string, included: boolean): GlRule {
  return { scope: "counterparty", source, counterparty_key: key, included };
}

describe("switching a bank feed on", () => {
  const inclusion = buildInclusion([srcRule("plaid", true)]);

  it("widens the query to that feed as well as the rows already counting", () => {
    const q = fakeQuery();
    inclusion.applyTo(q);
    expect(q.calls).toEqual(["or(include_in_gl.eq.true,source.in.(plaid))"]);
  });

  it("counts its rows even though the importer wrote them excluded", () => {
    expect(inclusion.allows(row({ source: "plaid", include_in_gl: false }))).toBe(true);
  });

  it("leaves every other feed alone", () => {
    expect(inclusion.allows(row({ source: "ramp", include_in_gl: true }))).toBe(true);
    expect(inclusion.allows(row({ source: "wells", include_in_gl: false }))).toBe(false);
  });
});

describe("switching a bank feed off", () => {
  const inclusion = buildInclusion([srcRule("ramp", false)]);

  it("does not widen the query -- an exclusion can only ever remove rows", () => {
    const q = fakeQuery();
    inclusion.applyTo(q);
    expect(q.calls).toEqual(["eq(include_in_gl,true)"]);
  });

  it("drops that feed's rows despite the row flag saying otherwise", () => {
    expect(inclusion.allows(row({ source: "ramp", include_in_gl: true }))).toBe(false);
  });
});

describe("switching one counterparty out of the books", () => {
  // The live case this exists for: four deposits from the business's own other
  // account, which moved the bank balance but are neither income nor expense.
  const OWN_ACCOUNT = "tpb operating funds (···· 4077)";
  const inclusion = buildInclusion([cpRule("ramp", OWN_ACCOUNT, false)]);

  it("drops only that counterparty, on only that feed", () => {
    expect(inclusion.allows(row({ counterparty_key: OWN_ACCOUNT }))).toBe(false);
    expect(inclusion.allows(row({ source: "plaid", counterparty_key: OWN_ACCOUNT, include_in_gl: true }))).toBe(true);
    expect(inclusion.allows(row({ counterparty_key: "gusto" }))).toBe(true);
  });

  it("is not expressed as a query filter, because the name is prose", () => {
    // Interpolating "(···· 4077)" into PostgREST filter syntax would produce a
    // filter that means something else entirely. The query stays as it was and
    // the row predicate does the work.
    const q = fakeQuery();
    inclusion.applyTo(q);
    expect(q.calls).toEqual(["eq(include_in_gl,true)"]);
  });

  it("matches a row that carries only a counterparty name", () => {
    // Plaid writes counterparty_name and no key, so the key is derived with the
    // same normaliser the Ramp sync uses.
    const byName = buildInclusion([cpRule("plaid", "square inc", false)]);
    expect(byName.allows({ source: "plaid", counterparty_key: null, counterparty_name: "Square Inc", include_in_gl: true })).toBe(false);
  });
});

describe("precedence", () => {
  it("lets a counterparty rule override its feed's rule", () => {
    const inclusion = buildInclusion([srcRule("plaid", true), cpRule("plaid", "internal transfer", false)]);
    expect(inclusion.allows(row({ source: "plaid", counterparty_key: "gusto", include_in_gl: false }))).toBe(true);
    expect(inclusion.allows(row({ source: "plaid", counterparty_key: "internal transfer", include_in_gl: false }))).toBe(false);
  });

  it("lets a counterparty rule override the row's own flag with no feed rule at all", () => {
    const inclusion = buildInclusion([cpRule("plaid", "square inc", true)]);
    expect(inclusion.allows(row({ source: "plaid", counterparty_key: "square inc", include_in_gl: false }))).toBe(true);
    // ...and the query has to fetch that feed, or the predicate never sees the row.
    const q = fakeQuery();
    inclusion.applyTo(q);
    expect(q.calls).toEqual(["or(include_in_gl.eq.true,source.in.(plaid))"]);
  });

  it("ignores a counterparty rule for a name the row does not have", () => {
    const inclusion = buildInclusion([cpRule("ramp", "gusto", false)]);
    expect(inclusion.allows(row({ counterparty_key: null, counterparty_name: null }))).toBe(true);
  });
});

describe("feed names are not trusted into the filter string", () => {
  it("drops a feed name that could change what the filter means", () => {
    // A name is a short code an importer writes; anything else loses its opt-in
    // rather than being interpolated, which can only ever narrow what counts.
    const inclusion = buildInclusion([srcRule("plaid),source.in.(ramp", true)]);
    const q = fakeQuery();
    inclusion.applyTo(q);
    expect(q.calls).toEqual(["eq(include_in_gl,true)"]);
  });

  it("still honours the rule in the row predicate", () => {
    // The dropped name only costs the query its widening; the decision itself
    // is unaffected, so nothing silently reverses meaning.
    const inclusion = buildInclusion([srcRule("odd name", false)]);
    expect(inclusion.allows(row({ source: "odd name", include_in_gl: true }))).toBe(false);
  });
});

describe("counterpartyKeyOf", () => {
  it("prefers the stored key", () => {
    expect(counterpartyKeyOf({ counterparty_key: "gusto", counterparty_name: "Something Else" })).toBe("gusto");
  });

  it("derives one from the name when there is no key", () => {
    expect(counterpartyKeyOf({ counterparty_key: null, counterparty_name: "  Duke   Energy " })).toBe("duke energy");
  });

  it("is null when there is neither", () => {
    expect(counterpartyKeyOf({ counterparty_key: null, counterparty_name: "   " })).toBe(null);
    expect(counterpartyKeyOf({})).toBe(null);
  });
});
