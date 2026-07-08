import { describe, it, expect } from "vitest";
import {
  exportStatusForLedger,
  buildAllocationInvoiceTimestamps,
  type AllocationInvoiceState,
} from "./reconcileInvoiceStatus";

const NOW = "2026-07-08T00:00:00.000Z";
const UPDATED = "2026-07-07T10:00:00.000Z";
const unsent: AllocationInvoiceState = { invoice_sent_at: null, invoice_paid_at: null };

describe("exportStatusForLedger", () => {
  it("targets 'paid' when the ledger is paid", () => {
    expect(exportStatusForLedger("paid")).toBe("paid");
  });
  it("targets 'unpaid' when open or partial", () => {
    expect(exportStatusForLedger("open")).toBe("unpaid");
    expect(exportStatusForLedger("partial")).toBe("unpaid");
  });
  it("targets nothing (null) for draft/voided/unknown", () => {
    expect(exportStatusForLedger("draft")).toBeNull();
    expect(exportStatusForLedger("voided")).toBeNull();
    expect(exportStatusForLedger("unknown")).toBeNull();
  });
});

describe("buildAllocationInvoiceTimestamps", () => {
  it("sets invoice_sent_at from updatedAt when a draft is published", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "UNPAID", ledgerStatus: "open", current: unsent, paidAt: null, updatedAt: UPDATED, now: NOW,
    });
    expect(u).toEqual({ invoice_sent_at: UPDATED });
  });

  it("falls back to now for the sent timestamp when updatedAt is null", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "UNPAID", ledgerStatus: "open", current: unsent, paidAt: null, updatedAt: null, now: NOW,
    });
    expect(u).toEqual({ invoice_sent_at: NOW });
  });

  it("does not touch invoice_sent_at when already sent", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "UNPAID", ledgerStatus: "open",
      current: { invoice_sent_at: "2026-07-01T00:00:00Z", invoice_paid_at: null },
      paidAt: null, updatedAt: UPDATED, now: NOW,
    });
    expect(u).toEqual({});
  });

  it("sets both sent and paid when an unsent invoice is already PAID", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "PAID", ledgerStatus: "paid", current: unsent, paidAt: "2026-07-06T00:00:00Z", updatedAt: UPDATED, now: NOW,
    });
    expect(u).toEqual({ invoice_sent_at: UPDATED, invoice_paid_at: "2026-07-06T00:00:00Z" });
  });

  it("sets paid from now when paidAt is null", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "PAID", ledgerStatus: "paid",
      current: { invoice_sent_at: "2026-07-01T00:00:00Z", invoice_paid_at: null },
      paidAt: null, updatedAt: UPDATED, now: NOW,
    });
    expect(u).toEqual({ invoice_paid_at: NOW });
  });

  it("does not re-set paid when already paid (idempotent)", () => {
    const u = buildAllocationInvoiceTimestamps({
      squareStatus: "PAID", ledgerStatus: "paid",
      current: { invoice_sent_at: "s", invoice_paid_at: "2026-07-06T00:00:00Z" },
      paidAt: "2026-07-06T00:00:00Z", updatedAt: UPDATED, now: NOW,
    });
    expect(u).toEqual({});
  });

  it("clears invoice_sent_at when canceled or failed", () => {
    expect(buildAllocationInvoiceTimestamps({
      squareStatus: "CANCELED", ledgerStatus: "voided",
      current: { invoice_sent_at: "s", invoice_paid_at: null }, paidAt: null, updatedAt: UPDATED, now: NOW,
    })).toEqual({ invoice_sent_at: null });
    expect(buildAllocationInvoiceTimestamps({
      squareStatus: "FAILED", ledgerStatus: "voided",
      current: { invoice_sent_at: "s", invoice_paid_at: null }, paidAt: null, updatedAt: UPDATED, now: NOW,
    })).toEqual({ invoice_sent_at: null });
  });

  it("does nothing for a still-draft invoice", () => {
    expect(buildAllocationInvoiceTimestamps({
      squareStatus: "DRAFT", ledgerStatus: "draft", current: unsent, paidAt: null, updatedAt: UPDATED, now: NOW,
    })).toEqual({});
  });
});
