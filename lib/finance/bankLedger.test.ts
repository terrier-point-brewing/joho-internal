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

  it("ledger records carry the normalized counterparty_key for auto-map", () => {
    // A Deposit from an outside bank is ledger-bound (not an expense) and has a
    // counterparty; its key must be persisted so counterparty rules can map it.
    const { ledgerRecords } = partitionBankLines(
      [line({ description: "Deposit", source_account_name: "STRIPE PAYMENTS", destination_account_name: "Operating Account" })],
      OWN,
    );
    expect(ledgerRecords[0]).toMatchObject({ counterparty_key: normalizeCounterparty("STRIPE PAYMENTS") });
  });
});

import { syncBankLedger, type BankLedgerRecord } from "./bankLedger";

function fakeSupabase(
  existing: Record<string, { mapping_source: string; chart_of_accounts_id: string | null; flow_type?: string; affects_pl?: boolean }> = {},
  counterpartyRules: Record<string, string> = {},
) {
  const upserts: BankLedgerRecord[] = [];
  return {
    upserts,
    from(table: string) {
      if (table === "expense_counterparty_mappings") {
        return {
          select() {
            return {
              eq() {
                return {
                  not: async () => ({
                    data: Object.entries(counterpartyRules).map(([counterparty_key, chart_of_accounts_id]) => ({ counterparty_key, chart_of_accounts_id })),
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
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
    description: "Interest", counterparty_name: "Interest", counterparty_key: "interest", source_account_name: null,
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
    const sb = fakeSupabase({ int: { mapping_source: "manual", chart_of_accounts_id: "coa-interest", flow_type: "interest_income", affects_pl: true } });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "manual", chart_of_accounts_id: "coa-interest" });
  });

  it("preserves a non-manual (e.g. rule-derived) prior chart_of_accounts_id across re-sync (fill-nulls-only)", async () => {
    const sb = fakeSupabase({ int: { mapping_source: "rule", chart_of_accounts_id: "coa-old-rule", flow_type: "interest_income", affects_pl: true } });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "rule", chart_of_accounts_id: "coa-old-rule" });
  });

  it("resolves chart_of_accounts_id from a counterparty rule for a fresh unmapped row", async () => {
    const sb = fakeSupabase({}, { interest: "coa-interest-income" });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "rule", chart_of_accounts_id: "coa-interest-income" });
  });

  it("leaves a row unmapped when no counterparty rule matches", async () => {
    const sb = fakeSupabase({}, { gusto: "coa-payroll" });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ mapping_source: "unmapped", chart_of_accounts_id: null });
  });

  it("preserves a manual flow_type recode across re-sync, even when re-classification would revert it", async () => {
    // Prior human recode: an unclassified row was manually set to internal_transfer.
    const sb = fakeSupabase({
      unc: { mapping_source: "manual", chart_of_accounts_id: null, flow_type: "internal_transfer", affects_pl: false },
    });
    const reclassified: BankLedgerRecord = {
      source: "ramp", source_transaction_id: "unc", amount_cents: -500000, currency_code: "USD",
      description: "Withdrawal", counterparty_name: "Mystery Co", counterparty_key: "mystery co", source_account_name: "Operating Account",
      destination_account_name: "Mystery Co", flow_type: "unclassified", affects_pl: false, transaction_date: "2026-07-01",
    };
    await syncBankLedger(sb as never, [reclassified]);
    expect(sb.upserts[0]).toMatchObject({ flow_type: "internal_transfer", affects_pl: false, mapping_source: "manual" });
  });

  it("lets the freshly-classified flow_type through for a non-manual prior row", async () => {
    const sb = fakeSupabase({ int: { mapping_source: "unmapped", chart_of_accounts_id: null, flow_type: "unclassified", affects_pl: false } });
    await syncBankLedger(sb as never, [rec]);
    expect(sb.upserts[0]).toMatchObject({ flow_type: "interest_income", affects_pl: true, mapping_source: "unmapped" });
  });
});
