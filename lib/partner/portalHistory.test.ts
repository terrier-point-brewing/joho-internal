import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requirePermission: vi.fn(), CAP: {} }));
vi.mock("@/lib/settings/breweryTimezone.server", () => ({ getBreweryTimezone: vi.fn() }));

import type { LedgerPartner } from "@/lib/production/partnerLedger";
import { toPortalHistory } from "./portal.server";

const inv = (id: string, status: string, total_cents: number, date = "2026-08-01") =>
  ({ id, invoice_number: id.toUpperCase(), invoice_date: date, status, source: "square", total_cents });
const shipment = (date: string, volume_bbl: number, invoice: ReturnType<typeof inv> | null, over: Record<string, unknown> = {}) =>
  ({ ...base(date, volume_bbl, invoice), ...over });
const base = (date: string, volume_bbl: number, invoice: ReturnType<typeof inv> | null) =>
  ({ shipment_id: date, date, batch_number: "B-001", batch_id: "b", transaction_ids: [], volume_bbl, status: "x", invoice, kind: "shipment" as const,
    lines: [{ variant_label: "1/6 Keg", quantity: 4, volume_bbl, over_allocation: false, is_ad_hoc: false, shipped_before_deposit: false }] });
const deposit = (over: Record<string, unknown> = {}) => ({
  state: "settled", via: null, invoice: null, paid_at: null, sent_at: null, paid_cents: 0, refunded_cents: 0, charged_cents: 0, collected_cents: 0, backcharge_invoices: [], ...over,
});
const totals = (over: Record<string, number> = {}) => ({
  owed_bbl: 0, shipped_bbl: 0, remaining_bbl: 0, in_tank_bbl: 0, uninvoiced_bbl: 0,
  deposit_billed_cents: 0, deposit_paid_cents: 0, deposit_refunded_cents: 0, export_billed_cents: 0, export_paid_cents: 0, ...over,
});
const deal = (over: Record<string, unknown>) => ({
  id: "c", recipe_name: "Beer", channel: "wholesale", stage: "closed", booked_bbl: 10, desired_delivery_date: null, received_on: "2026-06-01",
  locked_on: null, is_split: false, notes: "staff only", allocations: [], shipments: [], export_invoices: [], totals: totals(), ...over,
});

describe("toPortalHistory", () => {
  const shared = inv("inv-shared", "paid", 100_000);
  const unpaid = inv("inv-open", "open", 40_000, "2026-09-01");
  const ledger = {
    partner_id: "p", company_name: "Fortnight", allocations_by_batch: {}, unallocated_bbl: 1, unallocated_uninvoiced_transaction_ids: [], totals: totals(),
    unallocated: [shipment("2026-07-04", 1, null)],
    commitments: [
      deal({ id: "old", received_on: "2026-05-01", export_invoices: [shared], shipments: [shipment("2026-06-10", 5, shared)], totals: totals({ shipped_bbl: 5 }) }),
      deal({ id: "also-on-shared", received_on: "2026-07-01", export_invoices: [shared], shipments: [shipment("2026-07-10", 3, shared)], totals: totals({ shipped_bbl: 3 }) }),
      deal({
        id: "open-contract", stage: "open", channel: "contract_brewing", received_on: "2026-04-01",
        export_invoices: [unpaid, inv("inv-void", "voided", 999_999)],
        shipments: [shipment("2026-09-01", 2, unpaid), shipment("2026-09-10", 1, null)],
        allocations: [
          { deposit: deposit({ invoice: inv("dep-draft", "open", 70_000), sent_at: null }) },
          { deposit: deposit({ invoice: inv("dep-sent", "open", 30_000), sent_at: "2026-08-20" }) },
          { deposit: deposit({ paid_cents: 25_000, refunded_cents: 5_000 }) },
        ],
        totals: totals({ shipped_bbl: 3, owed_bbl: 10, remaining_bbl: 7, deposit_billed_cents: 100_000, deposit_paid_cents: 25_000 }),
      }),
    ],
  } as unknown as LedgerPartner;

  const h = toPortalHistory(ledger);

  it("puts open deals first, then newest", () => {
    expect(h.deals.map((d) => d.id)).toEqual(["open-contract", "also-on-shared", "old"]);
  });

  it("counts an invoice once however many deals it bills, and never a voided or unsent one", () => {
    // paid: shared 1,000 once + QuickBooks-marked deposit 250 − refund 50.
    expect(h.summary.paid_cents).toBe(120_000);
    // owed: the open shipment invoice 400 + the SENT deposit 300. Not the draft, not the void.
    expect(h.summary.outstanding_cents).toBe(70_000);
    expect(h.open_invoices.map((i) => i.id)).toEqual(["dep-sent", "inv-open"]);
  });

  it("totals shipped beer including drops outside any commitment", () => {
    expect(h.summary).toMatchObject({ shipped_bbl: 12, open_deals: 1, to_come_bbl: 7 });
    expect(h.other_shipments).toHaveLength(1);
  });

  it("labels every shipment and deposit with a payment status", () => {
    const open = h.deals[0];
    expect(open.shipments.map((s) => s.payment)).toEqual(["unpaid", "not_invoiced"]);
    expect(open.deposit).toMatchObject({ status: "unpaid" });
    expect(h.deals[2].shipments[0]).toMatchObject({ payment: "paid", invoice: { number: "INV-SHARED", total_cents: 100_000 } });
  });

  it("says what each invoice covers: the beer and how much of it", () => {
    const shared = h.deals[1].shipments[0].invoice!;
    expect(shared).toMatchObject({ beers: ["Beer"], bbl: 8 }); // 5 + 3 bbl across two deals, one beer name
    expect(h.open_invoices.find((i) => i.id === "inv-open")).toMatchObject({ bbl: 2 });
  });

  it("never passes staff notes or batch numbers through", () => {
    expect(JSON.stringify(h)).not.toMatch(/staff only|B-001/);
  });
});

describe("toPortalHistory — corrections, returns and shrinkage", () => {
  const paid = inv("inv-2kegs", "paid", 34_323, "2026-08-21");
  const ledger = {
    partner_id: "p", company_name: "Fortnight", allocations_by_batch: {}, unallocated_bbl: 0, unallocated_uninvoiced_transaction_ids: [], totals: totals(),
    // Entered as 8 half-kegs on Jul 30; corrected Aug 21 to 2. The period was
    // filed, so the original stays and a negative mirror cancels it.
    unallocated: [
      shipment("typo", 4, null),
      shipment("mirror", -4, null, { kind: "revision", reverses_shipment_id: "typo" }),
    ],
    commitments: [
      deal({
        id: "wiggo", stage: "open", received_on: "2026-06-19", booked_bbl: 4,
        shipments: [shipment("2026-08-21", 1, paid), shipment("came-back", -0.5, null, { kind: "refund" })],
        export_invoices: [paid],
        allocations: [{ id: "a1", batch_status: "complete", produced_bbl: 14.9, in_tank_bbl: 0, owed_bbl: 2.98, percentage: 20, batch_planned_bbl: 20, deposit: deposit() }],
        totals: totals({ shipped_bbl: 0.5, owed_bbl: 2.98, remaining_bbl: 2.48 }),
      }),
      deal({
        id: "blank-coast", stage: "closed", received_on: "2026-07-14", booked_bbl: 20,
        allocations: [{ id: "a2", batch_status: "complete", produced_bbl: 17.1, in_tank_bbl: 0, owed_bbl: 17.1, percentage: 100, batch_planned_bbl: 20, deposit: deposit() }],
        totals: totals({ shipped_bbl: 17.1, owed_bbl: 17.1 }),
      }),
      deal({
        id: "in-tank", stage: "open", received_on: "2026-09-11", booked_bbl: 20,
        allocations: [{ id: "a3", batch_status: "fermenting", produced_bbl: 0, in_tank_bbl: 17, owed_bbl: 0, percentage: 100, batch_planned_bbl: 20, deposit: deposit() }],
        totals: totals({ in_tank_bbl: 17 }),
      }),
      deal({ id: "no-batch", stage: "open", received_on: "2026-09-15", booked_bbl: 40 }),
    ],
  } as unknown as LedgerPartner;

  const extras = {
    today: "2026-09-20",
    invoices: new Map([["inv-2kegs", { due_date: "2026-09-04", pay_url: "https://squareup.com/pay-invoice/x" }]]),
    batches: new Map([["a3", { planned_brew_date: "2026-09-11", expected_delivery_date: "2026-10-16" }]]),
  };
  const h = toPortalHistory(ledger, undefined, extras);
  const byId = Object.fromEntries(h.deals.map((d) => [d.id, d]));

  it("drops a mistyped shipment together with the row that cancelled it", () => {
    expect(h.other_shipments).toEqual([]);
    // 0.5 net on Wiggo (1 out, 0.5 back) + 17.1 — and not the phantom 4.
    expect(h.summary.shipped_bbl).toBe(17.6);
  });

  it("shows a return as a return, with no invoice of its own", () => {
    expect(byId.wiggo.shipments.map((s) => [s.kind, s.volume_bbl, s.payment])).toEqual([["shipment", 1, "paid"], ["return", -0.5, "not_invoiced"]]);
  });

  it("measures delivery against what the batch really gave, not the pre-shrinkage booking", () => {
    expect(byId["blank-coast"]).toMatchObject({ booked_bbl: 20, produced_bbl: 17.1, expected_bbl: 17.1, shipped_bbl: 17.1 });
    expect(byId["in-tank"]).toMatchObject({ booked_bbl: 20, expected_bbl: 17, has_batch: true });
    expect(byId["no-batch"]).toMatchObject({ expected_bbl: 40, has_batch: false });
    // to come: Wiggo 2.48 packaged + 17 in tank + 40 not brewed yet.
    expect(h.summary.to_come_bbl).toBe(59.48);
  });

  it("says where each open deal's beer is", () => {
    expect(byId["no-batch"].progress).toMatchObject({ step: -1, label: "Awaiting a brew date" });
    expect(byId["in-tank"].progress).toMatchObject({ step: 2, label: "Fermenting", ready_by: "2026-10-16" });
    expect(byId.wiggo.progress).toMatchObject({ step: 5, label: "Packaged — ready to ship", ready_by: null });
  });

  it("carries the due date and pay link, and only calls an UNPAID invoice overdue", () => {
    expect(byId.wiggo.shipments[0].invoice).toMatchObject({ due_date: "2026-09-04", pay_url: "https://squareup.com/pay-invoice/x", overdue: false });
    const late = toPortalHistory({ ...ledger, commitments: [deal({ id: "x", export_invoices: [inv("inv-2kegs", "open", 500)] })] } as unknown as LedgerPartner, undefined, extras);
    expect(late.open_invoices[0]).toMatchObject({ overdue: true, days_overdue: 16 });
    expect(late.summary.overdue_cents).toBe(500);
  });
});

describe("toPortalHistory — a shipment is what the partner received", () => {
  const unpaid = inv("inv-one", "open", 50_000, "2026-09-19");
  const line = (label: string, quantity: number, volume_bbl: number, over = false) =>
    ({ variant_label: label, quantity, volume_bbl, over_allocation: over, is_ad_hoc: false, shipped_before_deposit: false });
  const ledger = {
    partner_id: "p", company_name: "Argus", unallocated_bbl: 0.14, unallocated_uninvoiced_transaction_ids: [], totals: totals(),
    allocations_by_batch: { "hop-roar-batch": [{ allocation_id: "a-hr", commitment_id: "hop-roar", recipe_name: "Hop Roar", batch_number: "B-070" }] },
    // The 21-case drop outran the deal's share of what had packaged, so the
    // ledger holds it as 19.6 credited + 1.4 uncredited on the same shipment id.
    unallocated: [
      shipment("2026-09-25", 0.14, null, { shipment_id: "drop", batch_id: "hop-roar-batch", lines: [line("Case", 1.4001, 0.14, true)] }),
      shipment("2026-09-20", 0.5, null, { shipment_id: "stray", batch_id: "no-deal-batch", lines: [line("1/6 Keg", 3, 0.5)] }),
    ],
    commitments: [
      deal({
        id: "hop-roar", recipe_name: "Hop Roar", stage: "open", channel: "contract_brewing", received_on: "2026-09-12", booked_bbl: 14,
        shipments: [
          shipment("2026-09-25", 1.9, null, { shipment_id: "drop", batch_id: "hop-roar-batch", lines: [line("Case", 19.5999, 1.9)] }),
          shipment("2026-09-19", 1, unpaid, { shipment_id: "s1", batch_id: "hop-roar-batch" }),
          shipment("2026-09-15", 1, unpaid, { shipment_id: "s2", batch_id: "hop-roar-batch" }),
        ],
        export_invoices: [unpaid],
        allocations: [{ id: "a-hr", batch_status: "fermenting", produced_bbl: 3.38, in_tank_bbl: 11.6, owed_bbl: 2.36, percentage: 70, batch_planned_bbl: 20,
          deposit: deposit({ invoice: inv("dep", "open", 30_000), sent_at: "2026-09-13" }) }],
        totals: totals({ shipped_bbl: 3.9, owed_bbl: 2.36, remaining_bbl: 0, in_tank_bbl: 11.6, deposit_billed_cents: 30_000 }),
      }),
      deal({ id: "later", stage: "open", received_on: "2026-09-01", allocations: [{ id: "a2", batch_status: "brewing", produced_bbl: 0, in_tank_bbl: 17, owed_bbl: 0, percentage: 100, batch_planned_bbl: 20, deposit: deposit() }], totals: totals({ in_tank_bbl: 17 }) }),
      deal({ id: "ready", stage: "open", received_on: "2026-08-01", allocations: [{ id: "a3", batch_status: "complete", produced_bbl: 17, in_tank_bbl: 0, owed_bbl: 17, percentage: 100, batch_planned_bbl: 20, deposit: deposit() }], totals: totals({ owed_bbl: 17, remaining_bbl: 17 }) }),
      deal({ id: "no-batch", stage: "open", received_on: "2026-09-20" }),
    ],
  } as unknown as LedgerPartner;
  const extras = { today: "2026-09-27", invoices: new Map(), batches: new Map([["a2", { planned_brew_date: "2026-09-01", expected_delivery_date: "2026-10-20" }], ["a-hr", { planned_brew_date: "2026-08-21", expected_delivery_date: "2026-10-10" }]]) };
  const h = toPortalHistory(ledger, undefined, extras);
  const hr = h.deals.find((d) => d.id === "hop-roar")!;

  it("shows the whole drop under the deal: 21 cases, one shipment, all counted as shipped", () => {
    const drop = hr.shipments.find((s) => s.date === "2026-09-25")!;
    expect(drop.lines).toEqual([{ label: "Case", quantity: 21 }]);
    expect(drop.volume_bbl).toBe(2.04);
    expect(hr.shipments).toHaveLength(3);
    expect(hr.shipped_bbl).toBe(4.04);
    expect(hr.expected_bbl).toBe(13.96); // owed 2.36 + 11.6 in tank ≥ shipped, so the estimate stands
  });

  it("keeps only beer from a batch the partner has no deal on as 'other'", () => {
    expect(h.other_shipments.map((s) => s.volume_bbl)).toEqual([0.5]);
    expect(h.summary.shipped_bbl).toBe(4.54);
  });

  it("counts one invoice once however many shipments it bills, and the deposit alongside it", () => {
    expect(hr.unpaid_invoices.map((i) => i.id)).toEqual(["dep", "inv-one"]);
    expect(hr.deposit).toMatchObject({ status: "unpaid", invoice: { id: "dep", total_cents: 30_000 } });
  });

  it("orders open deals by when the beer lands: ready, then by ready date, then no brew date", () => {
    expect(h.deals.map((d) => d.id)).toEqual(["ready", "hop-roar", "later", "no-batch"]);
  });
});
