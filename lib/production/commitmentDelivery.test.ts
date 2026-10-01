import { describe, it, expect } from "vitest";
import { commitmentDelivery } from "./commitmentDelivery";
import { buildPartnerLedger } from "./partnerLedger";

const produced = new Map([["b1", 32], ["b2", 0]]);
const exported = new Map([["a1", 11.5]]);

describe("commitmentDelivery", () => {
  it("closes a claim the moment its booked bbl has shipped, with the batch still in tank", () => {
    // 4 bbl claimed off a batch that is still packaging; the 12% is plumbing.
    const claim = (shipped: number) => commitmentDelivery({ storedStatus: "open", bookedBbl: 4,
      allocations: [{ id: "a1", batch_id: "b3", channel: "distribution", percentage: 12, batch_status: "conditioning", written_off: false }],
      producedByBatch: new Map([["b3", 12.9]]), projectedByBatch: new Map([["b3", 36]]), exportedByAllocation: new Map([["a1", shipped]]) });
    expect(claim(2.5)).toMatchObject({ owed_bbl: 4, remaining_bbl: 1.5, stage: "open" });
    expect(claim(4)).toMatchObject({ owed_bbl: 4, remaining_bbl: 0, stage: "closed" });
  });

  it("leaves a deal booked in turns to its percentage: shrinkage keeps it short of the booking", () => {
    // One 20 bbl turn that will package ~17: all 17 shipped, tank not yet closed out.
    const turn = (status: string) => commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b4", channel: "contract_brewing", percentage: 100, batch_status: status, written_off: false }],
      producedByBatch: new Map([["b4", 17]]), exportedByAllocation: new Map([["a1", 17]]) });
    expect(turn("conditioning")).toMatchObject({ owed_bbl: 17, stage: "open" });
    expect(turn("complete")).toMatchObject({ owed_bbl: 17, stage: "closed" });
  });

  it("caps every deal at its booking, soft channels included", () => {
    const contract = commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b1", channel: "contract_brewing", percentage: 75, batch_status: "complete", written_off: false }],
      producedByBatch: produced, exportedByAllocation: exported });
    expect(contract.owed_bbl).toBe(20);        // 75% x 32 = 24, capped at 20 booked
    expect(contract.remaining_bbl).toBe(8.5);
    expect(contract.stage).toBe("open");

    const soft = commitmentDelivery({ storedStatus: "open", bookedBbl: 20,
      allocations: [{ id: "a1", batch_id: "b1", channel: "distribution", percentage: 75, batch_status: "complete", written_off: false }],
      producedByBatch: produced, exportedByAllocation: exported });
    expect(soft.owed_bbl).toBe(20);            // was 24: the share, which left 4 bbl "owed" nobody asked for
  });

  it("while the batch is in tank the share is of its projected yield, not of what is packaged so far", () => {
    // B-033: 12.9 bbl packaged, ~23 more expected from tank; Argus shipped
    // 10.78 of it. Against packaged-so-far their 75% is 9.68 and they read as
    // over-delivered; against what the batch will make they are well inside.
    const d = commitmentDelivery({ storedStatus: "open", bookedBbl: 30,
      allocations: [{ id: "a1", batch_id: "b3", channel: "contract_brewing", percentage: 75, batch_status: "conditioning", written_off: false }],
      producedByBatch: new Map([["b3", 12.9]]), projectedByBatch: new Map([["b3", 36]]), exportedByAllocation: new Map([["a1", 10.78]]) });
    expect(d.allocations[0]).toMatchObject({ produced_bbl: 12.9, projected_bbl: 36, owed_bbl: 27, exported_bbl: 10.78 });
    expect(d.remaining_bbl).toBeCloseTo(16.22, 6);
    expect(d.stage).toBe("open");

    // A projection below produced (stale, or a batch that out-yielded its forecast) never shrinks the share.
    const stale = commitmentDelivery({ storedStatus: "open", bookedBbl: 30,
      allocations: [{ id: "a1", batch_id: "b1", channel: "contract_brewing", percentage: 75, batch_status: "complete", written_off: false }],
      producedByBatch: produced, projectedByBatch: new Map([["b1", 20]]), exportedByAllocation: exported });
    expect(stale.allocations[0].projected_bbl).toBe(32);
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
