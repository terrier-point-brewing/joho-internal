import { describe, expect, it } from "vitest";
import { homeAlerts } from "./alerts";
import type { PortalDeal, PortalHistory, PortalInvoice, PortalRefund, PortalRequest } from "./types";

const TODAY = "2026-10-30";
const invoice = (over: Partial<PortalInvoice> = {}): PortalInvoice => ({
  id: "i", number: "INV-1", date: "2026-09-01", kind: "shipment", status: "unpaid", total_cents: 10_000, beers: [], bbl: 1,
  due_date: "2026-10-01", overdue: true, days_overdue: 29, pay_url: null, refunded_cents: 0, payment_processing: false, ...over,
});
const deal = (over: Partial<PortalDeal> = {}): PortalDeal => ({
  id: "d", recipe_id: null, beer_name: "Vienna Lager", status: "open", booked_bbl: 20, produced_bbl: 20, expected_bbl: 20, has_batch: true,
  progress: { step: 5, label: "Ready", brew_date: "2026-09-01", ready_by: "2026-10-15" }, shipped_bbl: 8, remaining_bbl: 12, in_tank_bbl: 0,
  desired_delivery_date: null, received_on: null, deposit: null, shipments: [], unpaid_invoices: [], refunds: [], ...over,
});
const refund = (over: Partial<PortalRefund> = {}): PortalRefund => ({
  id: "r", date: "2026-10-12", amount_cents: 5_000, status: "completed", reason: "Deposit reduced", invoice: { id: "i", number: "INV-1" }, lines: [], ...over,
});
const request = (over: Partial<PortalRequest> = {}): PortalRequest => ({
  id: "q", kind: "batch", beer_name: "Oktoberfest", is_new_beer: false, turns: 1, volume_bbl: 20, wanted_bbl: 20, share_pct: 100, offer: null,
  desired_date: null, notes: null, status: "submitted", decision_note: null, decided_at: null, created_at: "2026-10-01", file_names: [],
  submitted_by: null, withdrawn_by: null, ...over,
});
const history = (over: Partial<PortalHistory> = {}): PortalHistory => ({
  summary: { shipped_bbl: 0, paid_cents: 0, outstanding_cents: 0, overdue_cents: 0, open_deals: 0, to_come_bbl: 0, refunded_cents: 0 },
  excise: { charged_cents: 0, collected_cents: 0, outstanding_cents: 0, invoices: 0 },
  open_invoices: [], deals: [], other_shipments: [], refunds: [], by_year: {}, ...over,
});

describe("homeAlerts", () => {
  it("is empty when nothing is waiting on the partner", () => {
    expect(homeAlerts(history(), [], TODAY)).toEqual([]);
    expect(homeAlerts(undefined, [], TODAY)).toEqual([]);
  });

  it("orders money overdue, then an offer, then an unpaid deposit, then beer ready, then refunds, then a decline", () => {
    const h = history({
      summary: { shipped_bbl: 0, paid_cents: 0, outstanding_cents: 10_000, overdue_cents: 10_000, open_deals: 2, to_come_bbl: 0, refunded_cents: 0 },
      open_invoices: [invoice()],
      deals: [
        deal({ id: "ready" }),
        deal({ id: "dep", beer_name: "Oktoberfest", progress: { step: 0, label: "Brewing", brew_date: "2026-11-03", ready_by: null }, shipped_bbl: 0,
          deposit: { billed_cents: 100_000, paid_cents: 0, status: "unpaid", invoice: null, billed_on: "own_invoice" } }),
      ],
      refunds: [refund()],
    });
    const reqs = [
      request({ id: "off", status: "adjusted", offer: { pct: 40, bbl: 8, note: null, offered_at: "2026-10-20", answered_at: null } }),
      request({ id: "no", beer_name: "Pils", status: "declined", decided_at: "2026-10-25", decision_note: "No lager tank free." }),
    ];
    const keys = homeAlerts(h, reqs, TODAY).map((a) => a.key);
    expect(keys).toEqual(["overdue", "offer:off", "deposit:dep", "ready", "refund:r", "declined:no"]);
  });

  it("words the rows for a partner", () => {
    const h = history({
      summary: { shipped_bbl: 0, paid_cents: 0, outstanding_cents: 10_000, overdue_cents: 10_000, open_deals: 1, to_come_bbl: 0, refunded_cents: 0 },
      open_invoices: [invoice()], deals: [deal()], refunds: [refund({ id: "p", status: "processing", date: null })],
    });
    const [overdue, ready, processing] = homeAlerts(h, [], TODAY);
    expect(overdue.title).toBe("$100.00 is overdue");
    expect(overdue.detail).toBe("1 invoice past due, the oldest by 29 days.");
    expect(ready.title).toBe("12 bbl of Vienna Lager is packaged and ready");
    expect(processing.title).toBe("$50.00 refund is processing");
    expect(processing.detail).toBe("Deposit reduced · invoice INV-1");
  });

  it("folds several ready beers into one row", () => {
    const h = history({ deals: [deal({ id: "a" }), deal({ id: "b", beer_name: "Pils", shipped_bbl: 10 })] });
    const [row] = homeAlerts(h, [], TODAY);
    expect(row.title).toBe("22 bbl across 2 beers is packaged and ready");
    expect(row.detail).toBe("Vienna Lager, Pils. On our floor now. Tell us when you want it.");
  });

  it("lets old refunds and old declines fall off", () => {
    const h = history({ refunds: [refund({ date: "2026-09-01" })] });
    const reqs = [request({ status: "declined", decided_at: "2026-10-01" })];
    expect(homeAlerts(h, reqs, TODAY)).toEqual([]);
  });

  it("does not flag a deposit before a brew is scheduled, nor beer that has all shipped", () => {
    const h = history({ deals: [
      deal({ has_batch: false, progress: { step: -1, label: "", brew_date: null, ready_by: null }, deposit: { billed_cents: 1, paid_cents: 0, status: "unpaid", invoice: null, billed_on: null } }),
      deal({ shipped_bbl: 20 }),
    ] });
    expect(homeAlerts(h, [], TODAY)).toEqual([]);
  });
});
