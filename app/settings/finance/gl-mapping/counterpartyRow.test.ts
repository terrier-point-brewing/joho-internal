import { describe, it, expect } from "vitest";
import { counterpartyRowState, rowKeyOf, type RowFacts, type InclusionState } from "./counterpartyRow";
import { OUT_OF_BOOKS } from "@/lib/finance/flowTypes";

const NO_RULES: InclusionState = { feeds: new Map(), counterparties: new Map() };

function rule(over: Partial<RowFacts> = {}): RowFacts {
  return {
    source: "plaid",
    counterparty_key: "erie insurance",
    flow_type: null,
    handledElsewhere: false,
    ...over,
  };
}

describe("step 1 — what is this money?", () => {
  it("is unanswered until a flow is stored", () => {
    const s = counterpartyRowState(rule(), NO_RULES);
    expect(s.treatment).toBe("");
    expect(s.bucket).toBe("awaiting-decision");
  });

  // The merge that removed the "In the books" toggle: an exclusion lives in a
  // different table, and the operator should never have to know that.
  it("reads an exclusion as the out-of-books answer", () => {
    const inclusion: InclusionState = {
      feeds: new Map(),
      counterparties: new Map([[rowKeyOf(rule()), false]]),
    };
    const s = counterpartyRowState(rule(), inclusion);
    expect(s.treatment).toBe(OUT_OF_BOOKS);
    expect(s.bucket).toBe("excluded");
    expect(s.asksAccountSource).toBe(false);
  });

  it("is not asked on a feed that classifies its own lines", () => {
    expect(counterpartyRowState(rule({ source: "ramp" }), NO_RULES).selfClassifying).toBe(true);
    expect(counterpartyRowState(rule({ source: "plaid" }), NO_RULES).selfClassifying).toBe(false);
  });
});

describe("step 2 — is the account asked for?", () => {
  it("only for the flows that use one", () => {
    for (const flow of ["operating_expense", "other_income", "balance_sheet_movement"]) {
      expect(counterpartyRowState(rule({ flow_type: flow }), NO_RULES).asksAccountSource).toBe(true);
    }
    for (const flow of ["card_settlement", "bill_settlement", "deposit", "internal_transfer"]) {
      expect(counterpartyRowState(rule({ flow_type: flow }), NO_RULES).asksAccountSource).toBe(false);
    }
  });

  it("is never asked before step 1 is answered", () => {
    expect(counterpartyRowState(rule({ flow_type: null }), NO_RULES).asksAccountSource).toBe(false);
  });

  // A Ramp counterparty's `expenses` rows are operating expenses by
  // construction, so its account is live even though step 1 never appeared.
  // This is the case a single merged dropdown could not serve.
  it("is always asked on a self-classifying feed", () => {
    const s = counterpartyRowState(rule({ source: "ramp", counterparty_key: "dukeenergy" }), NO_RULES);
    expect(s.asksAccountSource).toBe(true);
    expect(s.bucket).toBe("needs-account");
  });

  it("is not asked when the whole feed is switched off", () => {
    const inclusion: InclusionState = { feeds: new Map([["plaid", false]]), counterparties: new Map() };
    const s = counterpartyRowState(rule({ flow_type: "operating_expense" }), inclusion);
    expect(s.asksAccountSource).toBe(false);
    expect(s.bucket).toBe("feed-off");
  });

  // The feed switch wins over everything: a counterparty cannot be in the books
  // when the bank account it belongs to is out of them.
  it("a feed switched off beats a counterparty-level answer", () => {
    const inclusion: InclusionState = {
      feeds: new Map([["ramp", false]]),
      counterparties: new Map([["ramp gusto", false]]),
    };
    expect(counterpartyRowState(rule({ source: "ramp", counterparty_key: "gusto" }), inclusion).bucket)
      .toBe("feed-off");
  });
});

describe("summary buckets", () => {
  // Exactly one bucket per row — the summary's denominator depends on it, and a
  // row counted twice or not at all is how "3 of 7 mapped" stops meaning
  // anything.
  it("a claimed counterparty is handled elsewhere, not counted as needing an account", () => {
    const s = counterpartyRowState(rule({ flow_type: "deposit", handledElsewhere: true }), NO_RULES);
    expect(s.bucket).toBe("handled-elsewhere");
  });

  it("a settled flow with no account is finished, not outstanding", () => {
    expect(counterpartyRowState(rule({ flow_type: "internal_transfer" }), NO_RULES).bucket)
      .toBe("no-account-needed");
  });

  // "Finished" and "waiting on you" look identical if both are lumped together,
  // which is why they are separate buckets.
  it("tells an unanswered row apart from a settled one", () => {
    expect(counterpartyRowState(rule({ flow_type: null }), NO_RULES).bucket).toBe("awaiting-decision");
    expect(counterpartyRowState(rule({ flow_type: "bill_settlement" }), NO_RULES).bucket).toBe("no-account-needed");
  });

  // A claim answers WHICH ACCOUNT, not what the money is — so a claimed
  // counterparty still gets step 1. Square's Chase payouts sat unclassified for
  // want of that distinction.
  it("a claimed counterparty still carries a step 1 answer", () => {
    const s = counterpartyRowState(rule({ counterparty_key: "square", flow_type: "deposit", handledElsewhere: true }), NO_RULES);
    expect(s.treatment).toBe("deposit");
  });
});
