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
    // The two bills here sit six days apart to exercise the pairing, which the
    // repeated-bill check also (rightly) asks about; real rent is a month apart.
    expect(found.filter((c) => c.kind === "bill_vs_bank_line").map((c) => c.key).sort()).toEqual([
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

describe("findDuplicateCandidates — a charge the vendor already refunded", () => {
  // October 2026: RahrBSG billed $295.83 on 10/22, the card was also charged
  // $295.83 on 10/23, and Brewers Supply Group refunded the card on 11/2.
  const refunded = () =>
    inputs({
      billLines: [
        billLine({ sourceTransactionId: "bill-oct:0", amountCents: -26378, accountingDate: "2026-10-22", merchantName: "RahrBSG" }),
        billLine({ sourceTransactionId: "bill-oct:1", amountCents: -3205, accountingDate: "2026-10-22", merchantName: "RahrBSG" }),
      ],
      expenses: [
        expense({ id: "charge", amountCents: -29583, accountingDate: "2026-10-23", merchantName: "Brewers Supply Group" }),
        expense({ id: "refund", amountCents: 29583, accountingDate: "2026-11-02", merchantName: "Brewers Supply Group" }),
      ],
    });

  it("still proposes the pair, and says the charge was refunded", () => {
    const [c] = findDuplicateCandidates(refunded());
    expect(c.kind).toBe("bill_vs_card");
    expect(c.reversal).toMatchObject({ ids: ["refund"], date: "2026-11-02", amountCents: 29583 });
    expect(c.reason).toContain("refunded on 2026-11-02");
  });

  it("keeps the same key, so an answer already recorded is not asked again", () => {
    const withRefund = findDuplicateCandidates(refunded())[0].key;
    const before = refunded();
    before.expenses = before.expenses.filter((e) => e.id !== "refund");
    expect(findDuplicateCandidates(before)[0].key).toBe(withRefund);
  });

  it("does not read a refund from a different merchant as this charge's", () => {
    const i = refunded();
    i.expenses[1] = { ...i.expenses[1], merchantName: "Someone Else" };
    expect(findDuplicateCandidates(i)[0].reversal).toBeUndefined();
  });

  it("does not read an EARLIER credit as the refund", () => {
    const i = refunded();
    i.expenses[1] = { ...i.expenses[1], accountingDate: "2026-10-20" };
    expect(findDuplicateCandidates(i)[0].reversal).toBeUndefined();
  });

  it("ignores a refund that has itself been set aside", () => {
    const i = refunded();
    i.expenses[1] = { ...i.expenses[1], excluded: true };
    expect(findDuplicateCandidates(i)[0].reversal).toBeUndefined();
  });
});

describe("findDuplicateCandidates — one order billed twice", () => {
  const twoBills = (secondDate: string, secondLines: number[] = [-26378, -3205]) =>
    inputs({
      billLines: [
        billLine({ sourceTransactionId: "bill-a:0", amountCents: -26378, accountingDate: "2026-10-14", merchantName: "RahrBSG" }),
        billLine({ sourceTransactionId: "bill-a:1", amountCents: -3205, accountingDate: "2026-10-14", merchantName: "RahrBSG" }),
        ...secondLines.map((amountCents, n) =>
          billLine({ sourceTransactionId: `bill-b:${n}`, amountCents, accountingDate: secondDate, merchantName: "RahrBSG" }),
        ),
      ],
    });

  it("asks about two identical RahrBSG bills eight days apart", () => {
    const [c] = findDuplicateCandidates(twoBills("2026-10-22"));
    expect(c.kind).toBe("bill_vs_bill");
    expect(c.key).toBe("bill_vs_bill:bill-a:bill-b");
    expect(c.amountCents).toBe(-29583);
    expect(c.daysApart).toBe(8);
    // The LATER bill is the one that would be set aside, every line of it.
    expect(c.duplicate.date).toBe("2026-10-22");
    expect(c.duplicate.ids).toHaveLength(2);
    expect(c.periodEnd).toBe("2026-10-31");
  });

  it("leaves a monthly bill alone — rent is the same bill every month", () => {
    expect(findDuplicateCandidates(twoBills("2026-11-13"))).toEqual([]);
  });

  it("leaves a same-total bill with different lines alone", () => {
    expect(findDuplicateCandidates(twoBills("2026-10-22", [-29583]))).toEqual([]);
  });

  it("leaves another vendor's identical bill alone", () => {
    const i = twoBills("2026-10-22");
    i.billLines = i.billLines.map((l) => (l.sourceTransactionId.startsWith("bill-b") ? { ...l, merchantName: "Prairie Malt" } : l));
    expect(findDuplicateCandidates(i)).toEqual([]);
  });
});

describe("findDuplicateCandidates — Ramp's own record of what paid what", () => {
  // October 2026, with the real dates. One RahrBSG order was entered as two
  // bills of $295.83 (10/14 and 10/22). The card paid the FIRST on 10/14 but
  // only settled on 10/23, nine days from the bill it paid and one day from the
  // other; the second bill was paid from the bank. Brewers Supply Group
  // refunded the card on 11/2.
  const rahrBill = (id: string, date: string, link: string[] | null) => [
    billLine({ sourceTransactionId: `${id}:0`, amountCents: -26378, accountingDate: date, merchantName: "RahrBSG", paymentMethod: link ? "CARD" : "RTP", paymentTransactionIds: link }),
    billLine({ sourceTransactionId: `${id}:1`, amountCents: -3205, accountingDate: date, merchantName: "RahrBSG", paymentMethod: link ? "CARD" : "RTP", paymentTransactionIds: link }),
  ];
  const october = () =>
    inputs({
      billLines: [...rahrBill("bill-1014", "2026-10-14", ["ramp-txn-charge"]), ...rahrBill("bill-1022", "2026-10-22", null)],
      expenses: [
        expense({ id: "charge", sourceTransactionId: "ramp-txn-charge", amountCents: -29583, accountingDate: "2026-10-23", merchantName: "Brewers Supply Group" }),
        expense({ id: "refund", sourceTransactionId: "ramp-txn-refund", originalTransactionId: "ramp-txn-charge", amountCents: 29583, accountingDate: "2026-11-02", merchantName: "Brewers Supply Group" }),
      ],
    });
  const cardPairs = (i: DuplicateInputs) => findDuplicateCandidates(i).filter((c) => c.kind === "bill_vs_card");

  it("pairs a bill with the charge Ramp says paid it, outside the date window", () => {
    const found = cardPairs(october());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: "bill_vs_card:bill-1014:charge",
      evidence: "ramp_link",
      amountCents: -29583,
      daysApart: 9,
      periodEnd: "2026-10-31",
    });
    expect(found[0].reason).toContain("Ramp records this charge as the payment for this bill");
    expect(found[0].matched[0].ids).toHaveLength(2);
  });

  it("without the link, amount and date pick the WRONG bill — the case this exists for", () => {
    const i = october();
    i.billLines = i.billLines.map((l) => ({ ...l, paymentTransactionIds: null }));
    expect(cardPairs(i).map((c) => c.key)).toEqual(["bill_vs_card:bill-1022:charge"]);
  });

  it("never offers a linked charge to a same-amount stranger", () => {
    // The 10/22 bill is one day from the charge and would win on dates alone.
    expect(cardPairs(october()).some((c) => c.key.includes("bill-1022"))).toBe(false);
  });

  it("never offers a linked bill to a different same-amount charge", () => {
    const i = october();
    // Ramp's charge has been set aside; a stranger of the same amount sits a day from the linked bill.
    i.expenses[0] = { ...i.expenses[0], excluded: true };
    i.billLines = i.billLines.filter((l) => l.sourceTransactionId.startsWith("bill-1014"));
    i.expenses.push(expense({ id: "stranger", sourceTransactionId: "ramp-txn-other", amountCents: -29583, accountingDate: "2026-10-15", merchantName: "Somebody Else" }));
    expect(cardPairs(i)).toEqual([]);
  });

  it("does not hand a charge to a stranger because the bill it paid was set aside", () => {
    const i = october();
    i.billLines = i.billLines.map((l) => (l.sourceTransactionId.startsWith("bill-1014") ? { ...l, excluded: true } : l));
    expect(cardPairs(i)).toEqual([]);
  });

  it("asks nothing once the linked charge is set aside, declined or still pending", () => {
    for (const patch of [{ excluded: true }, { state: "DECLINED" }, { accountingDate: null, state: "PENDING" }]) {
      const i = october();
      i.expenses[0] = { ...i.expenses[0], ...patch };
      expect(cardPairs(i)).toEqual([]);
    }
  });

  it("still lets a linked bill meet a bank line — a second, separate way to pay it twice", () => {
    const i = october();
    i.bankLines = [bankLine({ id: "chase", amountCents: -29583, transactionDate: "2026-10-15" })];
    expect(findDuplicateCandidates(i).map((c) => c.kind).sort()).toEqual(["bill_vs_bank_line", "bill_vs_bill", "bill_vs_card"]);
  });

  it("keeps the key a pair already had, so a recorded answer is not asked again", () => {
    // In window and equal in amount: found before the link existed, and after.
    const withLink = inputs({
      billLines: [billLine({ sourceTransactionId: "pm-nov:0", amountCents: -118335, accountingDate: "2026-11-13", paymentMethod: "CARD", paymentTransactionIds: ["t-nov"] })],
      expenses: [expense({ id: "card-nov", sourceTransactionId: "t-nov", amountCents: -118335, accountingDate: "2026-11-16" })],
    });
    const without = { ...withLink, billLines: withLink.billLines.map((l) => ({ ...l, paymentTransactionIds: null })) };
    const [a] = findDuplicateCandidates(withLink);
    const [b] = findDuplicateCandidates(without);
    expect(a.key).toBe("bill_vs_card:pm-nov:card-nov");
    expect(b.key).toBe(a.key);
    expect(a.evidence).toBe("ramp_link");
    expect(b.evidence).toBeUndefined();
  });

  describe("the refund link", () => {
    it("reads the refund from Ramp's link, and says the charge was undone", () => {
      const [c] = cardPairs(october());
      expect(c.reversal).toMatchObject({ ids: ["refund"], date: "2026-11-02", amountCents: 29583 });
      expect(c.reason).toContain("refunded on 2026-11-02");
    });

    it("follows the link where the old inference could not: another merchant name, past 60 days", () => {
      const i = october();
      i.expenses[1] = { ...i.expenses[1], merchantName: "BSG Refunds", accountingDate: "2027-01-20" };
      expect(cardPairs(i)[0].reversal).toMatchObject({ ids: ["refund"] });
    });

    it("prefers the link over a nearer same-merchant charge of the same amount", () => {
      const i = october();
      // A later identical charge, which "most recent before the refund" would have picked.
      i.expenses.push(expense({ id: "later-charge", sourceTransactionId: "ramp-txn-later", amountCents: -29583, accountingDate: "2026-10-30", merchantName: "Brewers Supply Group" }));
      expect(cardPairs(i).find((c) => c.duplicate.ids[0] === "charge")?.reversal).toMatchObject({ ids: ["refund"] });
    });

    it("does not guess for a refund whose linked charge is somewhere else", () => {
      const i = october();
      i.expenses[1] = { ...i.expenses[1], originalTransactionId: "a-charge-not-in-the-table" };
      expect(cardPairs(i)[0].reversal).toBeUndefined();
    });

    it("does not call a partial refund an undoing", () => {
      const i = october();
      i.expenses[1] = { ...i.expenses[1], amountCents: 10000 };
      expect(cardPairs(i)[0].reversal).toBeUndefined();
    });
  });

  describe("the fallback, where Ramp has no link", () => {
    it("pairs a manually paid bill with a card charge on amount and date, as before", () => {
      const found = findDuplicateCandidates(
        inputs({
          billLines: PRAIRIE_JUNE.map((l) => ({ ...l, paymentMethod: "PAID_MANUALLY", paymentTransactionIds: null })),
          expenses: [expense({ id: "card-boortmalt-0617", sourceTransactionId: "t-1", amountCents: -56455 })],
        }),
      );
      expect(found).toHaveLength(1);
      expect(found[0].key).toBe("bill_vs_card:pm-june:card-boortmalt-0617");
      expect(found[0].evidence).toBeUndefined();
      expect(found[0].reason).toBe(
        'Card charge "Boortmalt" on 2026-06-17 is the same $564.55 as the Prairie Malt bill of 2026-06-16, 1 day apart.',
      );
    });

    it("still holds an unlinked pair to the date window", () => {
      const found = findDuplicateCandidates(
        inputs({ billLines: PRAIRIE_JUNE, expenses: [expense({ id: "c", sourceTransactionId: "t-1", amountCents: -56455, accountingDate: "2026-06-24" })] }),
      );
      expect(found).toEqual([]);
    });

    it("still infers a refund with no link from merchant, amount and date", () => {
      const i = october();
      i.expenses[1] = { ...i.expenses[1], originalTransactionId: null };
      expect(cardPairs(i)[0].reversal).toMatchObject({ ids: ["refund"] });
    });
  });
});
