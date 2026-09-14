import { describe, it, expect } from "vitest";
import { buildPartnerLedger, groupShipments, type LedgerAllocationRow, type LedgerExportRow, type LedgerInput } from "./partnerLedger";

function alloc(over: Partial<LedgerAllocationRow>): LedgerAllocationRow {
  return {
    id: "a1", batch_id: "b1", channel: "contract_brewing", partner_id: "argus", contract_request_id: "c1",
    percentage: 75, invoice_paid_at: null, invoice_sent_at: null, invoice_generated_at: null,
    deposit_backcharged_invoice_id: null, square_deposit_invoice_id: null, refund_amount_cents: null,
    written_off_at: null, deposit_amount_paid_cents: null, refunded_at: null, written_off_bbl: null, write_off_note: null,
    batch_number: "B-034", batch_status: "complete", batch_planned_bbl: 40, beer_name: "Epic Hazy IPA",
    ...over,
  };
}

function exp(over: Partial<LedgerExportRow>): LedgerExportRow {
  return {
    id: "e1", shipment_id: "s1", batch_id: "b1", batch_number: "B-034", recipe_id: "r1", recipe_name: "Epic Hazy IPA",
    channel: "contract_brewing", recipient_id: "argus", allocation_id: "a1", variant_label: "1/2 Keg", quantity: 8,
    volume_bbl: 4, status: "paid", invoice_id: "inv-x1", is_ad_hoc: false, over_allocation: false, is_phantom: false,
    source_ref: null, created_at: "2026-08-01T00:00:00Z", ...over,
  };
}

function base(over: Partial<LedgerInput> = {}): LedgerInput {
  return {
    partners: [{ id: "argus", company_name: "Argus Beverage Ventures LLC" }, { id: "fort", company_name: "Fortnight" }],
    commitments: [{
      id: "c1", partner_id: "argus", recipe_id: "r1", recipe_name: "Epic Hazy IPA", channel: "contract_brewing", status: "open",
      volume_bbl: 30, desired_delivery_date: "2026-08-06", received_on: "2026-07-01", locked_on: "2026-07-20",
      split_from_commitment_id: null, notes: null,
    }],
    allocations: [alloc({ invoice_paid_at: "2026-07-20", square_deposit_invoice_id: "sq-35", deposit_amount_paid_cents: 238328 })],
    producedByBatch: new Map([["b1", 32.56]]),
    allocatedPctByBatch: new Map([["b1", 100]]),
    exports: [
      exp({ id: "e1", shipment_id: "s1", volume_bbl: 7.59, invoice_id: "inv-x1" }),
      exp({ id: "e2", shipment_id: "s2", volume_bbl: 4, invoice_id: null, status: "invoice_required", created_at: "2026-09-01T00:00:00Z" }),
    ],
    invoices: [
      { id: "inv-d35", invoice_number: "000035", invoice_date: "2026-07-09", status: "paid", source: "square", invoice_type: "allocation_deposit", total_cents: 238328, square_invoice_id: "sq-35", allocation_id: "a1" },
      { id: "inv-x1", invoice_number: "000040", invoice_date: "2026-08-02", status: "open", source: "square", invoice_type: "export_invoice", total_cents: 91000, square_invoice_id: "sq-40", allocation_id: null },
    ],
    chargesByAllocation: new Map(),
    ...over,
  };
}

describe("buildPartnerLedger", () => {
  it("one row per commitment: booked → batch % → owed (capped at booked) → shipped → remaining, deposit and invoices", () => {
    const [argus] = buildPartnerLedger(base());
    expect(argus.company_name).toBe("Argus Beverage Ventures LLC");
    const c = argus.commitments[0];
    expect(c.stage).toBe("shipping");
    expect(c.booked_bbl).toBe(30);
    expect(c.allocations[0]).toMatchObject({ batch_number: "B-034", percentage: 75, produced_bbl: 32.56, owed_bbl: 24.42, exported_bbl: 11.59, remaining_bbl: 12.83, batch_unallocated_pct: 0 });
    expect(c.allocations[0].deposit).toMatchObject({ state: "settled", via: "own_invoice", paid_cents: 238328 });
    expect(c.allocations[0].deposit.invoice?.invoice_number).toBe("000035");
    expect(c.totals).toMatchObject({ owed_bbl: 24.42, shipped_bbl: 11.59, remaining_bbl: 12.83, uninvoiced_bbl: 4, deposit_paid_cents: 238328, export_billed_cents: 91000, export_paid_cents: 0 });
    expect(c.shipments.map((s) => s.shipment_id)).toEqual(["s2", "s1"]); // newest first
    expect(c.shipments[0].invoice).toBeNull();
    expect(c.shipments[1].invoice?.invoice_number).toBe("000040");
  });

  it("over-delivery and ad-hoc drops sit under the partner, never inside a commitment", () => {
    const [argus] = buildPartnerLedger(base({
      exports: [
        exp({ id: "e1", volume_bbl: 11.59 }),
        exp({ id: "e9", shipment_id: "s9", allocation_id: null, over_allocation: true, volume_bbl: 2.13, invoice_id: null, status: "invoice_required" }),
      ],
    }));
    expect(argus.commitments[0].totals.shipped_bbl).toBe(11.59);
    expect(argus.unallocated).toHaveLength(1);
    expect(argus.unallocated_bbl).toBe(2.13);
    expect(argus.unallocated[0].lines[0].over_allocation).toBe(true);
  });

  it("back-charged deposits: charges roll into billed/paid and the state reads collecting", () => {
    const b = base();
    const [argus] = buildPartnerLedger(base({
      allocations: [alloc({ deposit_backcharged_invoice_id: "inv-x1" })],
      // No standing deposit invoice — the deposit is collected on the export invoice.
      invoices: b.invoices.filter((i) => i.invoice_type !== "allocation_deposit"),
      chargesByAllocation: new Map([["a1", { chargedCents: 48218, collectedCents: 48218, unpaidCount: 0, chargedBbl: 5.23, invoiceIds: ["inv-x1"] }]]),
    }));
    const a = argus.commitments[0].allocations[0];
    expect(a.deposit.state).toBe("collecting");
    expect(a.deposit.backcharge_invoices[0].invoice_number).toBe("000040");
    expect(argus.commitments[0].totals.deposit_billed_cents).toBe(48218);
    expect(argus.commitments[0].totals.deposit_paid_cents).toBe(48218);
  });

  it("partners with nothing are omitted; a commitment with no allocation still lists as needing a batch", () => {
    const out = buildPartnerLedger(base({ allocations: [], exports: [] }));
    expect(out).toHaveLength(1);
    expect(out[0].commitments[0].stage).toBe("unplanned");
    expect(out[0].commitments[0].totals.owed_bbl).toBe(0);
  });

  it("flags the unallocated share of a batch on the allocation line", () => {
    const [argus] = buildPartnerLedger(base({ allocatedPctByBatch: new Map([["b1", 40]]) }));
    expect(argus.commitments[0].allocations[0].batch_unallocated_pct).toBe(60);
  });
});

describe("groupShipments", () => {
  it("one shipment per shipment_id with its lines summed, refund rows labelled", () => {
    const inv = new Map();
    const out = groupShipments([
      exp({ id: "e1", shipment_id: "s1", variant_label: "1/2 Keg", quantity: 2, volume_bbl: 1 }),
      exp({ id: "e2", shipment_id: "s1", variant_label: "1/6 Keg", quantity: 3, volume_bbl: 0.5 }),
      exp({ id: "e3", shipment_id: "s2", quantity: -8, volume_bbl: -0.77, source_ref: "refund:abc", created_at: "2026-08-08T00:00:00Z" }),
    ], inv);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ shipment_id: "s2", kind: "refund", volume_bbl: -0.77 });
    expect(out[1]).toMatchObject({ shipment_id: "s1", kind: "shipment", volume_bbl: 1.5 });
    expect(out[1].lines).toHaveLength(2);
  });
});
