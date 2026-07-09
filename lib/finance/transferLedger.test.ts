import { describe, it, expect } from "vitest";
import { classifyTransfers, transferToLedgerRecord } from "./transferLedger";
import type { RampTransfer, RampStatement } from "@/lib/ramp";

function transfer(id: string, amount: number, status = "COMPLETED", created_at = "2026-06-26T05:15:26Z"): RampTransfer {
  return { id, amount, status, created_at };
}
function statement(charges: number): RampStatement {
  return { id: `s-${charges}`, end_date: "2026-06-26", charges, credits: 0, payments: 0, ending_balance: 0, statement_url: null };
}

describe("classifyTransfers", () => {
  it("tags a transfer that exactly matches a statement's charges as card_settlement", () => {
    const res = classifyTransfers([transfer("t1", 6880.82)], [statement(6880.82)]);
    expect(res).toHaveLength(1);
    expect(res[0].flow_type).toBe("card_settlement");
    expect(res[0].transfer.id).toBe("t1");
  });

  it("reconciles summed transfers to a statement's charges (partial payments)", () => {
    const res = classifyTransfers(
      [transfer("may1", 11337.59), transfer("may2", 1588.56)],
      [statement(12926.15)],
    );
    expect(res.map((r) => r.flow_type)).toEqual(["card_settlement", "card_settlement"]);
  });

  it("handles an exact match and a summed remainder together", () => {
    const res = classifyTransfers(
      [transfer("jun", 6880.82), transfer("may1", 11337.59), transfer("may2", 1588.56)],
      [statement(6880.82), statement(12926.15)],
    );
    expect(res.every((r) => r.flow_type === "card_settlement")).toBe(true);
  });

  it("marks a transfer that reconciles to nothing as unclassified (never auto-booked)", () => {
    const res = classifyTransfers([transfer("x", 999.99)], [statement(6880.82)]);
    expect(res[0].flow_type).toBe("unclassified");
  });

  it("marks everything unclassified when there are no statements to match against", () => {
    const res = classifyTransfers([transfer("x", 500)], []);
    expect(res[0].flow_type).toBe("unclassified");
  });

  it("excludes non-COMPLETED transfers entirely (unsettled cash never enters the ledger)", () => {
    const res = classifyTransfers(
      [transfer("done", 6880.82, "COMPLETED"), transfer("pending", 6880.82, "PENDING")],
      [statement(6880.82)],
    );
    expect(res).toHaveLength(1);
    expect(res[0].transfer.id).toBe("done");
    expect(res[0].flow_type).toBe("card_settlement");
  });

  it("does NOT sweep leftover transfers that only sum across MULTIPLE unrelated statements", () => {
    // leftover sum 100+200 = 300 equals charges 120+180 summed, but no single
    // charge is 300 → must stay unclassified, not be bulk-tagged.
    const res = classifyTransfers(
      [transfer("a", 100), transfer("b", 200)],
      [statement(120), statement(180)],
    );
    expect(res.map((r) => r.flow_type)).toEqual(["unclassified", "unclassified"]);
  });
});

describe("transferToLedgerRecord", () => {
  it("builds an outflow-negative, non-P&L card_settlement ledger record", () => {
    const r = transferToLedgerRecord(transfer("t1", 6880.82), "card_settlement");
    expect(r).toMatchObject({
      source: "ramp",
      source_transaction_id: "t1",
      amount_cents: -688082,
      flow_type: "card_settlement",
      affects_pl: false,
      transaction_date: "2026-06-26",
      description: "Card statement payment",
    });
  });

  it("labels an unclassified transfer generically", () => {
    const r = transferToLedgerRecord(transfer("t2", 500), "unclassified");
    expect(r.flow_type).toBe("unclassified");
    expect(r.description).toBe("Transfer");
  });
});
