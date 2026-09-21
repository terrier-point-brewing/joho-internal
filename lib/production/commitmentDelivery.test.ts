import { describe, it, expect } from "vitest";
import { commitmentDelivery } from "./commitmentDelivery";
import { buildPartnerLedger } from "./partnerLedger";

const produced = new Map([["b1", 32], ["b2", 0]]);
const exported = new Map([["a1", 11.5]]);

describe("commitmentDelivery", () => {
  it("caps a contract deal at its booking, owes a soft channel its produced share", () => {
    const contract = commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b1", channel: "contract_brewing", percentage: 75, batch_status: "complete", written_off: false }],
      producedByBatch: produced, exportedByAllocation: exported });
    expect(contract.owed_bbl).toBe(20);        // 75% x 32 = 24, capped at 20 booked
    expect(contract.remaining_bbl).toBe(8.5);
    expect(contract.stage).toBe("open");

    const soft = commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b1", channel: "distribution", percentage: 75, batch_status: "complete", written_off: false }],
      producedByBatch: produced, exportedByAllocation: exported });
    expect(soft.owed_bbl).toBe(24);
  });

  it("a written-off remainder closes the deal and leaves nothing remaining", () => {
    const d = commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b1", channel: "contract_brewing", percentage: 75, batch_status: "complete", written_off: true }],
      producedByBatch: produced, exportedByAllocation: exported });
    expect(d.stage).toBe("closed");
    expect(d.remaining_bbl).toBe(0);
  });

  it("the Partner Ledger reports exactly these figures for the same deal", () => {
    const [partner] = buildPartnerLedger({
      partners: [{ id: "p1", company_name: "Argus" }],
      commitments: [{ id: "c1", partner_id: "p1", recipe_id: "r1", recipe_name: "Hazy", channel: "contract_brewing", status: "open", volume_bbl: 20, desired_delivery_date: null, received_on: null, locked_on: null, split_from_commitment_id: null, notes: null }],
      allocations: [{ id: "a1", batch_id: "b1", channel: "contract_brewing", partner_id: "p1", contract_request_id: "c1", percentage: 75,
        batch_number: "B-001", batch_status: "complete", batch_planned_bbl: 40, beer_name: "Hazy",
        invoice_paid_at: null, invoice_sent_at: null, invoice_generated_at: null, deposit_backcharged_invoice_id: null, square_deposit_invoice_id: null,
        deposit_amount_paid_cents: null, refund_amount_cents: null, refunded_at: null, written_off_at: null, written_off_bbl: null, write_off_note: null }],
      exports: [{ id: "e1", allocation_id: "a1", volume_bbl: 11.5 }],
      invoices: [], producedByBatch: produced, inTankByBatch: new Map(), chargesByAllocation: new Map(),
      allocatedPctByBatch: new Map(), convertedByBatch: new Map(),
    } as unknown as Parameters<typeof buildPartnerLedger>[0]);
    const deal = partner.commitments[0];
    expect([deal.totals.owed_bbl, deal.totals.shipped_bbl, deal.totals.remaining_bbl, deal.stage]).toEqual([20, 11.5, 8.5, "open"]);
  });
});
