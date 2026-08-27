import { describe, it, expect } from "vitest";
import { rampReimbursementToExpenseRecord } from "./rampExpenses";
import type { RampReimbursement } from "@/lib/ramp";

/**
 * Shaped from the live /reimbursements payload, so the adapter is tested against
 * what Ramp actually sends rather than what the docs imply. Notably `amount` is
 * already DOLLARS on this endpoint, unlike the minor-unit money objects
 * everywhere else in lib/ramp.ts.
 */
function claim(over: Partial<RampReimbursement> = {}): RampReimbursement {
  return {
    id: "rb-1",
    amount: 84.8,
    currency_code: "USD",
    merchant: "Wake ABC",
    user_full_name: "Aliza Wolford",
    memo: "Beer licence run",
    state: "REIMBURSED",
    direction: "BUSINESS_TO_USER",
    transaction_date: "2026-05-06",
    accounting_date: "2026-05-06",
    payment_processed_at: "2026-05-09T00:47:39+00:00",
    payment_id: "CRBWEJU6-1234",
    sync_status: "NOT_SYNC_READY",
    accounting_field_selections: [],
    line_items: [],
    ...over,
  };
}

describe("rampReimbursementToExpenseRecord", () => {
  it("books the claim as an expense on the date it was incurred", () => {
    expect(rampReimbursementToExpenseRecord(claim())).toMatchObject({
      source: "ramp",
      ramp_object: "reimbursement",
      source_transaction_id: "rb-1",
      accounting_date: "2026-05-06",
      state: "REIMBURSED",
    });
  });

  // The date the employee happened to get PAID is not when the money was spent.
  // Using it was one of the two errors that made the payout-as-expense treatment
  // wrong; the other was forcing one account onto a batch.
  it("dates the expense to the purchase, not to the payout", () => {
    const rec = rampReimbursementToExpenseRecord(claim());
    expect(rec.accounting_date).toBe("2026-05-06");
    expect(rec.settled_at).toBe("2026-05-09T00:47:39+00:00");
  });

  it("is an outflow — money left the business", () => {
    expect(rampReimbursementToExpenseRecord(claim()).amount_cents).toBe(-8480);
  });

  // A claim awaiting payment is still money the business owes, exactly like an
  // open bill, so it is an expense now and settles later.
  it("an unpaid claim is an expense with no settlement date", () => {
    const rec = rampReimbursementToExpenseRecord(claim({
      state: "AWAITING_PAYMENT", payment_processed_at: null, payment_id: null, amount: 14.15,
    }));
    expect(rec.settled_at).toBeNull();
    expect(rec.amount_cents).toBe(-1415);
    expect(rec.state).toBe("AWAITING_PAYMENT");
  });

  // merchant_name is what the money was FOR, which is what a GL rule keys on.
  // Naming the employee there would make every rule about the person.
  it("records the merchant as the counterparty and the employee as the buyer", () => {
    const rec = rampReimbursementToExpenseRecord(claim());
    expect(rec.merchant_name).toBe("Wake ABC");
    expect(rec.card_holder_name).toBe("Aliza Wolford");
  });

  it("reads GL coding from the claim's line items", () => {
    const rec = rampReimbursementToExpenseRecord(claim({
      line_items: [{
        accounting_field_selections: [{
          id: "gl-1",
          category_info: { type: "GL_ACCOUNT" },
          name: "Brewery Utilities",
          external_code: "5140",
        }],
      }],
    }));
    expect(rec.external_account_id).toBe("gl-1");
    expect(rec.external_account_code).toBe("5140");
  });

  it("leaves the account unset when the claim is uncoded", () => {
    expect(rampReimbursementToExpenseRecord(claim()).external_account_id).toBeNull();
  });

  // An uncoded claim's only route to the chart of accounts is its merchant: the
  // key seeds a rule row on the Counterparties screen, and one standing answer
  // there codes every future claim at that merchant.
  describe("the counterparty key on an uncoded claim", () => {
    it("keys an uncoded claim by its merchant, normalized", () => {
      const rec = rampReimbursementToExpenseRecord(claim({ merchant: "Food Lion" }));
      expect(rec.counterparty_key).toBe("food lion");
      expect(rec.counterparty_label).toBe("Food Lion");
    });

    // Casing and spacing vary run to run; the rule is looked up by the key, so
    // two spellings of one merchant must not become two rules.
    it("collapses a merchant's spellings onto one key", () => {
      const a = rampReimbursementToExpenseRecord(claim({ merchant: "FOOD  LION" }));
      const b = rampReimbursementToExpenseRecord(claim({ merchant: "Food Lion" }));
      expect(a.counterparty_key).toBe(b.counterparty_key);
    });

    // Not an optimisation: external_account_id already outranks a counterparty
    // rule, so keying a coded claim changes no coding — it would only put a
    // one-off merchant on a screen that lists decisions still owed.
    it("does not key a claim Ramp already coded", () => {
      const rec = rampReimbursementToExpenseRecord(claim({
        merchant: "Undercover Band",
        line_items: [{
          accounting_field_selections: [{
            id: "gl-1", category_info: { type: "GL_ACCOUNT" }, name: "Entertainment", external_code: "6320",
          }],
        }],
      }));
      expect(rec.external_account_id).toBe("gl-1");
      expect(rec.counterparty_key).toBeNull();
      expect(rec.counterparty_label).toBeNull();
    });

    // A claim naming nobody has nothing to key on. Null is the correct answer:
    // an empty-string key would be a rule row every nameless claim shared.
    it("leaves a claim with no merchant unkeyed", () => {
      for (const merchant of [null, ""]) {
        const rec = rampReimbursementToExpenseRecord(claim({ merchant }));
        expect(rec.counterparty_key).toBeNull();
        expect(rec.counterparty_label).toBeNull();
      }
    });
  });

  // `expenses.state` is upper-case-only (expenses_state_upper_check); a lower
  // case value once dropped every bank row off the cash-flow statement.
  it("upper-cases the state, and treats Ramp's empty sentinel as null", () => {
    expect(rampReimbursementToExpenseRecord(claim({ state: "awaiting_payment" })).state).toBe("AWAITING_PAYMENT");
    expect(rampReimbursementToExpenseRecord(claim({ state: "" })).state).toBeNull();
  });

  it("falls back to the transaction date when there is no accounting date", () => {
    expect(rampReimbursementToExpenseRecord(claim({ accounting_date: null })).transaction_time).toBe("2026-05-06");
  });
});
