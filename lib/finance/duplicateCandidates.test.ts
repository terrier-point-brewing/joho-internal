import { describe, it, expect } from "vitest";
import {
  findDuplicateCandidates,
  groupBills,
  type BillLineInput,
  type ExpenseInput,
  type BankLineInput,
  type ManualFlowInput,
  type DuplicateInputs,
} from "./duplicateCandidates";

// The fixtures below are the duplicates found by hand while closing September
// 2026 — same vendors, dates and cents. If the matcher stops finding any of
// them, it has stopped doing the one job it was written for.

function billLine(o: Partial<BillLineInput> & { sourceTransactionId: string; amountCents: number }): BillLineInput {
  return {
    id: `line-${o.sourceTransactionId}`,
    merchantName: "Prairie Malt",
    accountingDate: "2026-06-16",
    settledAt: null,
    excluded: false,
    ...o,
  };
}

function expense(o: Partial<ExpenseInput> & { id: string; amountCents: number }): ExpenseInput {
  return {
    rampObject: "card",
    merchantName: "Boortmalt",
    accountingDate: "2026-06-17",
    state: "CLEARED",
    excluded: false,
    ...o,
  };
}

function bankLine(o: Partial<BankLineInput> & { id: string; amountCents: number }): BankLineInput {
  return { source: "plaid", name: "Cdp Leasing Inc", transactionDate: "2026-10-05", flowType: "unclassified", ...o };
}

function inputs(o: Partial<DuplicateInputs>): DuplicateInputs {
  return { billLines: [], expenses: [], bankLines: [], manualFlows: [], ...o };
}

/** Prairie Malt, 2026-06-16, $564.55 across four line items. */
const PRAIRIE_JUNE: BillLineInput[] = [
  billLine({ sourceTransactionId: "pm-june:0", amountCents: -30000, settledAt: "2026-06-16T15:00:00Z" }),
  billLine({ sourceTransactionId: "pm-june:1", amountCents: -20000, settledAt: "2026-06-16T15:00:00Z" }),
  billLine({ sourceTransactionId: "pm-june:2", amountCents: -5000, settledAt: "2026-06-16T15:00:00Z" }),
  billLine({ sourceTransactionId: "pm-june:3", amountCents: -1455, settledAt: "2026-06-16T15:00:00Z" }),
];

describe("groupBills", () => {
  it("rolls line items up to one bill by the id before the colon", () => {
    const [bill] = groupBills(PRAIRIE_JUNE);
    expect(bill.billId).toBe("pm-june");
    expect(bill.amountCents).toBe(-56455);
    expect(bill.lineIds).toHaveLength(4);
    expect(bill.settledDate).toBe("2026-06-16");
  });

  it("leaves a set-aside line out of the bill's total", () => {
    const lines = PRAIRIE_JUNE.map((l, i) => (i === 3 ? { ...l, excluded: true } : l));
    expect(groupBills(lines)[0].amountCents).toBe(-55000);
  });
});

describe("findDuplicateCandidates — a bill and the card charge that paid it", () => {
  it("pairs Prairie Malt's bill with the Boortmalt card charge despite the different names", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: PRAIRIE_JUNE, expenses: [expense({ id: "card-boortmalt-0617", amountCents: -56455 })] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "bill_vs_card",
      key: "bill_vs_card:pm-june:card-boortmalt-0617",
      amountCents: -56455,
      daysApart: 1,
      periodEnd: "2026-06-30",
    });
    expect(found[0].duplicate).toMatchObject({ table: "expenses", ids: ["card-boortmalt-0617"], name: "Boortmalt" });
    expect(found[0].matched[0]).toMatchObject({ what: "Ramp bill", name: "Prairie Malt" });
    expect(found[0].matched[0].ids).toHaveLength(4);
    expect(found[0].reason).toBe(
      'Card charge "Boortmalt" on 2026-06-17 is the same $564.55 as the Prairie Malt bill of 2026-06-16, 1 day apart.',
    );
  });

  it("finds the July pair too ($1,168.90, bill 7/8, card 7/10)", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [billLine({ sourceTransactionId: "pm-july:0", amountCents: -116890, accountingDate: "2026-07-08", settledAt: "2026-07-09T12:00:00Z" })],
        expenses: [expense({ id: "card-0710", amountCents: -116890, accountingDate: "2026-07-10" })],
      }),
    );
    expect(found.map((c) => c.key)).toEqual(["bill_vs_card:pm-july:card-0710"]);
  });

  it("needs the amount to the cent", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: PRAIRIE_JUNE, expenses: [expense({ id: "c", amountCents: -56456 })] }),
    );
    expect(found).toEqual([]);
  });

  it("does not pair a refund of the same size — the sign has to match", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: PRAIRIE_JUNE, expenses: [expense({ id: "c", amountCents: 56455 })] }),
    );
    expect(found).toEqual([]);
  });

  it("ignores a same-amount charge outside the date window", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: PRAIRIE_JUNE, expenses: [expense({ id: "c", amountCents: -56455, accountingDate: "2026-06-24" })] }),
    );
    expect(found).toEqual([]);
  });

  it("measures the window from the day the bill was PAID when that is later", () => {
    // CDP Leasing: billed 9/25, paid 10/6. A charge on 10/10 is 15 days from the
    // bill and 4 from its payment.
    const found = findDuplicateCandidates(
      inputs({
        billLines: [billLine({ sourceTransactionId: "cdp:0", amountCents: -669000, accountingDate: "2026-09-25", settledAt: "2026-10-06T14:00:00Z" })],
        expenses: [expense({ id: "c", amountCents: -669000, accountingDate: "2026-10-10" })],
      }),
    );
    expect(found).toHaveLength(1);
  });

  it("skips what is already answered: set aside, declined, or still pending", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: PRAIRIE_JUNE,
        expenses: [
          expense({ id: "set-aside", amountCents: -56455, excluded: true }),
          expense({ id: "declined", amountCents: -56455, state: "DECLINED" }),
          expense({ id: "pending", amountCents: -56455, accountingDate: null, state: "PENDING" }),
        ],
      }),
    );
    expect(found).toEqual([]);
  });
});

describe("findDuplicateCandidates — a bill and the account debit that paid it", () => {
  it("pairs R.H. Barringer's bill (9/25, $146.32) with the Ramp debit of 9/29", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [
          billLine({ sourceTransactionId: "rhb:0", merchantName: "R.H. Barringer Distributing Co.", amountCents: -10000, accountingDate: "2026-09-25", settledAt: "2026-10-01T10:00:00Z" }),
          billLine({ sourceTransactionId: "rhb:1", merchantName: "R.H. Barringer Distributing Co.", amountCents: -4632, accountingDate: "2026-09-25", settledAt: "2026-10-01T10:00:00Z" }),
        ],
        expenses: [expense({ id: "debit-0929", rampObject: "bank", merchantName: "R.H. Barringer D", amountCents: -14632, accountingDate: "2026-09-29" })],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "bill_vs_ramp_debit", periodEnd: "2026-09-30", daysApart: 4 });
    expect(found[0].duplicate.what).toBe("Ramp account debit");
  });
});

describe("findDuplicateCandidates — a bill and a bank line", () => {
  const CDP_SEPT = [
    billLine({ sourceTransactionId: "cdp-sept:0", merchantName: "CDP Leasing, Inc.", amountCents: -669000, accountingDate: "2026-09-25", settledAt: "2026-10-06T14:00:00Z" }),
  ];

  it("flags the unclassified Chase debit that would double the rent if it were mapped", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: CDP_SEPT, bankLines: [bankLine({ id: "chase-1005", amountCents: -669000 })] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "bill_vs_bank_line", periodEnd: "2026-10-31", daysApart: 10 });
    expect(found[0].duplicate).toMatchObject({ table: "bank_ledger", what: "Chase bank line" });
  });

  it("still flags it once someone HAS mapped it to an expense", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: CDP_SEPT, bankLines: [bankLine({ id: "chase-1005", amountCents: -669000, flowType: "operating_expense" })] }),
    );
    expect(found).toHaveLength(1);
  });

  it("is satisfied by a line typed bill_settlement", () => {
    const found = findDuplicateCandidates(
      inputs({ billLines: CDP_SEPT, bankLines: [bankLine({ id: "chase-1005", amountCents: -669000, flowType: "bill_settlement" })] }),
    );
    expect(found).toEqual([]);
  });

  it("gives each month's rent its own payment when the amount recurs", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [
          billLine({ sourceTransactionId: "cdp-may:0", merchantName: "CDP Leasing, Inc.", amountCents: -669000, accountingDate: "2026-05-30", settledAt: "2026-06-01T14:00:00Z" }),
          billLine({ sourceTransactionId: "cdp-june:0", merchantName: "CDP Leasing, Inc.", amountCents: -669000, accountingDate: "2026-06-05", settledAt: "2026-06-08T14:00:00Z" }),
        ],
        bankLines: [
          bankLine({ id: "check-0604", amountCents: -669000, transactionDate: "2026-06-04" }),
          bankLine({ id: "check-0601", amountCents: -669000, transactionDate: "2026-06-01" }),
        ],
      }),
    );
    expect(found.map((c) => c.key).sort()).toEqual([
      "bill_vs_bank_line:cdp-june:check-0604",
      "bill_vs_bank_line:cdp-may:check-0601",
    ]);
  });

  it("reports a bill doubled two different ways as two candidates", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: CDP_SEPT,
        expenses: [expense({ id: "card", amountCents: -669000, accountingDate: "2026-09-26" })],
        bankLines: [bankLine({ id: "chase-1005", amountCents: -669000 })],
      }),
    );
    expect(found.map((c) => c.kind)).toEqual(["bill_vs_card", "bill_vs_bank_line"]);
  });
});

describe("findDuplicateCandidates — a manual entry restating the feed", () => {
  const RAHR_MAY = billLine({
    sourceTransactionId: "rahr-may:0",
    merchantName: "RahrBSG",
    amountCents: -176704,
    accountingDate: "2026-05-05",
    settledAt: "2026-06-01T21:41:48Z",
  });
  const INTEREST = bankLine({ id: "interest-0601", source: "ramp", name: "Interest", amountCents: 3316, transactionDate: "2026-06-01", flowType: "other_income" });
  const WALLET_DEBIT: ManualFlowInput = {
    id: "manual-jun1",
    label: "Jun 1 wallet debit missing from the Ramp feed",
    startDate: "2026-06-01",
    endDate: "2026-06-01",
    amountCents: -173388,
  };

  it("finds the Jun 1 wallet debit as a bill paid that day net of an interest credit", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [RAHR_MAY],
        bankLines: [INTEREST, bankLine({ id: "noise", source: "ramp", name: "Transfer", amountCents: 2194039, transactionDate: "2026-06-02", flowType: "internal_transfer" })],
        expenses: [expense({ id: "noise-card", merchantName: "Amazon", amountCents: -2499, accountingDate: "2026-06-01" })],
        manualFlows: [WALLET_DEBIT],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "manual_vs_feed",
      amountCents: -173388,
      periodEnd: "2026-06-30",
      key: "manual_vs_feed:manual-jun1:interest-0601+line-rahr-may:0",
    });
    expect(found[0].duplicate).toMatchObject({ table: "manual_entries", ids: ["manual-jun1"] });
    expect(found[0].matched.map((m) => m.amountCents).sort((a, b) => a - b)).toEqual([-176704, 3316]);
    expect(found[0].reason).toContain("is exactly the net of");
  });

  it("dates a bill by the day it was paid, not the day it was issued", () => {
    // Same bill, but settled a week later: nothing moved on June 1.
    const found = findDuplicateCandidates(
      inputs({ billLines: [{ ...RAHR_MAY, settledAt: "2026-06-08T21:00:00Z" }], bankLines: [INTEREST], manualFlows: [WALLET_DEBIT] }),
    );
    expect(found).toEqual([]);
  });

  it("prefers a single row of the exact amount over a combination", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [RAHR_MAY],
        bankLines: [INTEREST],
        expenses: [expense({ id: "exact", rampObject: "bank", merchantName: "Ramp", amountCents: -173388, accountingDate: "2026-06-01" })],
        manualFlows: [WALLET_DEBIT],
      }),
    );
    expect(found.filter((c) => c.kind === "manual_vs_feed")[0].matched.map((m) => m.ids[0])).toEqual(["exact"]);
  });

  it("leaves a month-long accrual alone", () => {
    const found = findDuplicateCandidates(
      inputs({
        billLines: [RAHR_MAY],
        bankLines: [INTEREST],
        manualFlows: [{ ...WALLET_DEBIT, startDate: "2026-06-01", endDate: "2026-06-30" }],
      }),
    );
    expect(found).toEqual([]);
  });
});

describe("findDuplicateCandidates — stability", () => {
  it("returns the same keys whatever order the rows arrive in", () => {
    const base = inputs({
      billLines: PRAIRIE_JUNE,
      expenses: [expense({ id: "a", amountCents: -56455 }), expense({ id: "b", amountCents: -56455, accountingDate: "2026-06-18" })],
    });
    const forward = findDuplicateCandidates(base).map((c) => c.key);
    const reversed = findDuplicateCandidates({ ...base, billLines: [...base.billLines].reverse(), expenses: [...base.expenses].reverse() }).map((c) => c.key);
    expect(forward).toEqual(["bill_vs_card:pm-june:a"]);
    expect(reversed).toEqual(forward);
  });
});
