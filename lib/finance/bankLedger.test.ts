import { describe, it, expect } from "vitest";
import { classifyBankLine, partitionBankLines } from "./bankLedger";
import { normalizeCounterparty, type RampBankLine } from "@/lib/ramp";

const OWN = new Set(["operating account", "investment account"].map(normalizeCounterparty));

function line(over: Partial<RampBankLine> = {}): RampBankLine {
  return {
    id: "k1", amount: 150.39, currency_code: "USD", date: "2026-07-07T00:00:00Z",
    description: "Withdrawal", source_account_name: "Operating Account", destination_account_name: "GUSTO",
    ...over,
  };
}

describe("classifyBankLine", () => {
  it("Withdrawal to an external party is an operating expense (routes to expenses)", () => {
    const c = classifyBankLine(line(), OWN);
    expect(c).toMatchObject({ flow_type: "operating_expense", is_expense: true, affects_pl: true, direction: "outflow", counterparty_key: "gusto" });
  });

  it("Interest is income, not an expense", () => {
    const c = classifyBankLine(line({ description: "Interest", source_account_name: null, destination_account_name: "Operating Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "interest_income", is_expense: false, affects_pl: true, direction: "inflow" });
  });

  it("Vendor Payment is a bill settlement, excluded from P&L (no double-count with bills)", () => {
    const c = classifyBankLine(line({ description: "Vendor Payment", destination_account_name: null }), OWN);
    expect(c).toMatchObject({ flow_type: "bill_settlement", is_expense: false, affects_pl: false, direction: "outflow" });
  });

  it("Withdrawal between own accounts is an internal transfer", () => {
    const c = classifyBankLine(line({ destination_account_name: "Investment Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "internal_transfer", is_expense: false, affects_pl: false, direction: "outflow" });
  });

  it("a card-balance payment is a card settlement, excluded from P&L", () => {
    const c = classifyBankLine(line({ destination_account_name: "Ramp Card" }), OWN);
    expect(c).toMatchObject({ flow_type: "card_settlement", is_expense: false, affects_pl: false, direction: "outflow" });
  });

  it("Deposit is non-P&L pending review", () => {
    const c = classifyBankLine(line({ description: "Deposit", source_account_name: "OUTSIDE BANK", destination_account_name: "Operating Account" }), OWN);
    expect(c).toMatchObject({ flow_type: "deposit", is_expense: false, affects_pl: false, direction: "inflow" });
  });

  it("a Withdrawal with no counterparty is unclassified (never silently an expense)", () => {
    const c = classifyBankLine(line({ destination_account_name: null }), OWN);
    expect(c).toMatchObject({ flow_type: "unclassified", is_expense: false, affects_pl: false, direction: "outflow" });
  });

  it("an unknown description is unclassified", () => {
    const c = classifyBankLine(line({ description: "Adjustment" }), OWN);
    expect(c).toMatchObject({ flow_type: "unclassified", is_expense: false, affects_pl: false });
  });

  it("a Withdrawal to a whitespace-only destination is unclassified, never a silent expense (regression)", () => {
    const c = classifyBankLine(line({ destination_account_name: "   " }), OWN);
    expect(c).toMatchObject({ flow_type: "unclassified", is_expense: false });
  });

  it("a Withdrawal to an own account whose name contains 'ramp' is an internal transfer, not a card settlement", () => {
    const ownWithRamp = new Set([...OWN, normalizeCounterparty("Ramp Reserve")]);
    const c = classifyBankLine(line({ destination_account_name: "Ramp Reserve" }), ownWithRamp);
    expect(c).toMatchObject({ flow_type: "internal_transfer", is_expense: false, affects_pl: false });
  });
});

describe("partitionBankLines", () => {
  const lines = [
    line({ id: "exp", description: "Withdrawal", destination_account_name: "ERIE INSURANCE", amount: 271.05 }),
    line({ id: "int", description: "Interest", source_account_name: null, destination_account_name: "Operating Account", amount: 40.01 }),
    line({ id: "xfer", description: "Withdrawal", destination_account_name: "Investment Account", amount: 5000 }),
  ];
  const { expenseRecords, ledgerRecords } = partitionBankLines(lines, OWN);

  it("routes operating expenses to expense records (ramp_object=bank, outflow-negative)", () => {
    expect(expenseRecords).toHaveLength(1);
    expect(expenseRecords[0]).toMatchObject({
      source: "ramp", ramp_object: "bank", source_transaction_id: "exp",
      amount_cents: -27105, merchant_name: "ERIE INSURANCE", counterparty_key: "erie insurance",
      external_account_id: null,
    });
  });

  it("routes interest + transfer to ledger records with flow_type + affects_pl and correct sign", () => {
    expect(ledgerRecords.map((r) => r.flow_type).sort()).toEqual(["interest_income", "internal_transfer"]);
    const interest = ledgerRecords.find((r) => r.flow_type === "interest_income")!;
    expect(interest).toMatchObject({ amount_cents: 4001, affects_pl: true });   // inflow positive
    const xfer = ledgerRecords.find((r) => r.flow_type === "internal_transfer")!;
    expect(xfer.amount_cents).toBe(-500000);                                     // outflow negative
    expect(xfer.affects_pl).toBe(false);
  });
});

import { syncBankLedger, type BankLedgerRecord } from "./bankLedger";

function fakeSupabase(existing: Record<string, { mapping_source: string; chart_of_accounts_id: string | null }> = {}) {
  const upserts: BankLedgerRecord[] = [];
  return {
    upserts,
    from() {
      return {
        select() { return { eq() { return { in: async () => ({ data: Object.entries(existing).map(([source_transaction_id, v]) => ({ source_transaction_id, ...v })), error: null }) }; } }; },
        upsert: async (rows: BankLedgerRecord[]) => { upserts.push(...rows); return { error: null }; },
      };
    },
  };
}

describe("syncBankLedger", () => {
  const rec: BankLedgerRecord = {
    source: "ramp", source_transaction_id: "int", amount_cents: 4001, currency_code: "USD",
    description: "Interest", counterparty_name: "Interest", source_account_name: null,
    destination_account_name: "Operating Account", flow_type: "interest_income", affects_pl: true, transaction_date: "2026-07-01",
  };

  it("upserts ledger rows and reports counts by flow_type", async () => {
    const sb = fakeSupabase();
    const res = await syncBankLedger(sb as never, [rec]);
    expect(res.imported).toBe(1);
    expect(res.by_flow_type.interest_income).toBe(1);
    expect(sb.upserts[0]).toMatchObject({ source_transaction_id: "int", mapping_source: "unmapped", chart_of_accounts_id: null });
  });

  it("preserves a manually-coded row's mapping_source + chart_of_accounts_id across re-sync", async () => {
    const sb = fakeSupabase({ int: { mapping_source: "manual", chart_of_accounts_id: "coa-interest" } });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "manual", chart_of_accounts_id: "coa-interest" });
  });

  it("resets a non-manual (e.g. rule-derived) prior mapping to unmapped/null on re-sync", async () => {
    const sb = fakeSupabase({ int: { mapping_source: "rule", chart_of_accounts_id: "coa-old-rule" } });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "unmapped", chart_of_accounts_id: null });
  });
});
