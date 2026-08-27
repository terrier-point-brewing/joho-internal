import { describe, it, expect } from "vitest";
import { validateBankSplit, resolveBankGlLines, flowAllowsSplit } from "./bankLedgerSplits";
import { FLOW_TYPES } from "./flowTypes";

const WIRE = -40062500; // the 2026-04-21 acquisition wire, in cents

function line(coa: string, cents: number) {
  return { chartOfAccountsId: coa, amountCents: cents, memo: null };
}

describe("flowAllowsSplit", () => {
  it("allows exactly one flow, and it is the balance sheet movement", () => {
    const allowed = FLOW_TYPES.filter((f) => flowAllowsSplit(f.key)).map((f) => f.key);
    expect(allowed).toEqual(["balance_sheet_movement"]);
  });

  // An unknown key answers false for the same reason flowNeedsAccount does: "I
  // do not recognise this flow" must never mean "so let it carry an allocation".
  it("answers false for null and for a flow this build does not know", () => {
    expect(flowAllowsSplit(null)).toBe(false);
    expect(flowAllowsSplit(undefined)).toBe(false);
    expect(flowAllowsSplit("some_future_flow")).toBe(false);
  });
});

describe("validateBankSplit", () => {
  const good = [line("coa-machinery", -30000000), line("coa-kegs", -10062500)];

  it("accepts lines that balance to the parent to the cent", () => {
    expect(validateBankSplit(good, WIRE, "balance_sheet_movement")).toEqual({ ok: true });
  });

  // The P&L's bank fetch has no split expansion, so a split stored on a
  // P&L-bound row would be accepted and then silently ignored by the statement.
  it("refuses every flow but balance_sheet_movement", () => {
    for (const f of FLOW_TYPES.filter((f) => f.key !== "balance_sheet_movement")) {
      const res = validateBankSplit(good, WIRE, f.key);
      expect(res.ok, `${f.key} must not be splittable`).toBe(false);
    }
  });

  it("refuses lines that do not add up, and says by how much", () => {
    const res = validateBankSplit([line("a", -30000000), line("b", -10000000)], WIRE, "balance_sheet_movement");
    expect(res).toEqual({ ok: false, error: "Split lines are off by -62500 cents" });
  });

  it("needs at least two lines — one line is not a split", () => {
    expect(validateBankSplit([line("a", WIRE)], WIRE, "balance_sheet_movement").ok).toBe(false);
  });

  it("needs an account on every line", () => {
    const res = validateBankSplit([line("", -30000000), line("b", -10062500)], WIRE, "balance_sheet_movement");
    expect(res).toEqual({ ok: false, error: "Every split line needs a GL account" });
  });

  // A line running against the parent is a transfer between two balance-sheet
  // accounts wearing an allocation's clothes, and the pair would net to less
  // than the money that actually moved.
  it("refuses a line running the other way, even when the total still balances", () => {
    const res = validateBankSplit(
      [line("a", -45000000), line("b", 4937500)],
      WIRE,
      "balance_sheet_movement",
    );
    expect(res).toEqual({ ok: false, error: "Split lines must run the same direction as the bank line" });
  });

  it("refuses the same account twice — that is an unedited line, not an allocation", () => {
    const res = validateBankSplit(
      [line("coa-machinery", -30000000), line("coa-machinery", -10062500)],
      WIRE,
      "balance_sheet_movement",
    );
    expect(res).toEqual({ ok: false, error: "Each split line needs a different GL account" });
  });

  it("refuses zero lines and a zero-amount parent", () => {
    expect(validateBankSplit([line("a", -40062500), line("b", 0)], WIRE, "balance_sheet_movement").ok).toBe(false);
    expect(validateBankSplit([line("a", 1), line("b", -1)], 0, "balance_sheet_movement").ok).toBe(false);
  });

  it("works the same on an inflow", () => {
    expect(validateBankSplit([line("a", 60000), line("b", 40000)], 100000, "balance_sheet_movement")).toEqual({ ok: true });
  });
});

describe("resolveBankGlLines", () => {
  it("uses the splits when there are any", () => {
    const splits = [line("a", -30000000), line("b", -10062500)];
    expect(resolveBankGlLines(splits, { chartOfAccountsId: "own", amountCents: WIRE })).toEqual(splits);
  });

  it("synthesizes one line from the row's own coding when there is no split", () => {
    expect(resolveBankGlLines([], { chartOfAccountsId: "own", amountCents: WIRE }))
      .toEqual([{ chartOfAccountsId: "own", amountCents: WIRE, memo: null }]);
  });

  // An uncoded row posts nothing. Inventing a line for it would be inventing an
  // account, which is how a number reaches a statement that nobody chose.
  it("returns nothing for a row with neither", () => {
    expect(resolveBankGlLines([], { chartOfAccountsId: null, amountCents: WIRE })).toEqual([]);
  });
});
