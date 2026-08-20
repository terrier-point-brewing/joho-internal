import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SquareApiError } from "@/lib/square/client";

const getInvoiceStatus = vi.fn();
const getOrderPayment = vi.fn();
vi.mock("@/lib/square/square-invoices", () => ({
  getInvoiceStatus: (...args: unknown[]) => getInvoiceStatus(...args),
  getOrderPayment: (...args: unknown[]) => getOrderPayment(...args),
}));

import {
  exportStatusForLedger,
  buildAllocationInvoiceTimestamps,
  cascadeExportTransactionsStatus,
  reconcileInvoiceStatus,
  MISSING_SQUARE_STATUS,
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
  it("targets 'invoice_required' when voided, releasing the shipment to be re-invoiced", () => {
    expect(exportStatusForLedger("voided")).toBe("invoice_required");
  });
  it("targets nothing (null) for draft/unknown", () => {
    expect(exportStatusForLedger("draft")).toBeNull();
    expect(exportStatusForLedger("unknown")).toBeNull();
  });
});

/**
 * Minimal Supabase stub for `export_transactions.update().eq(...).eq/neq(...).select()`
 * chains. Records the filter calls so tests can assert which rows the update
 * would target without a real client.
 */
function exportTransactionsUpdateStub(opts: { returned: Array<{ id: string }> }) {
  const calls: { payload: Record<string, unknown>; filters: Array<{ method: string; args: unknown[] }> } = {
    payload: {},
    filters: [],
  };
  const client = {
    from: (table: string) => {
      if (table !== "export_transactions") throw new Error(`unexpected table ${table}`);
      return {
        update: (payload: Record<string, unknown>) => {
          calls.payload = payload;
          const chain = {
            eq: (...args: unknown[]) => { calls.filters.push({ method: "eq", args }); return chain; },
            neq: (...args: unknown[]) => { calls.filters.push({ method: "neq", args }); return chain; },
            select: () => Promise.resolve({ data: opts.returned, error: null }),
          };
          return chain;
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("cascadeExportTransactionsStatus", () => {
  it("flips unpaid/invoice_required rows to paid, scoped to this invoice and not already paid", async () => {
    const { client, calls } = exportTransactionsUpdateStub({ returned: [{ id: "tx-1" }, { id: "tx-2" }] });

    const updated = await cascadeExportTransactionsStatus(client, "inv-1", "paid");

    expect(updated).toBe(2);
    expect(calls.payload).toEqual({ status: "paid" });
    expect(calls.filters).toContainEqual({ method: "eq", args: ["invoice_id", "inv-1"] });
    expect(calls.filters).toContainEqual({ method: "neq", args: ["status", "paid"] });
  });

  it("advances invoice_required rows to unpaid when the ledger is open/partial", async () => {
    const { client, calls } = exportTransactionsUpdateStub({ returned: [{ id: "tx-1" }] });

    const updated = await cascadeExportTransactionsStatus(client, "inv-2", "open");

    expect(updated).toBe(1);
    expect(calls.payload).toEqual({ status: "unpaid" });
    expect(calls.filters).toContainEqual({ method: "eq", args: ["invoice_id", "inv-2"] });
    expect(calls.filters).toContainEqual({ method: "eq", args: ["status", "invoice_required"] });
  });

  it("touches nothing for draft/unknown ledger statuses", async () => {
    const { client, calls } = exportTransactionsUpdateStub({ returned: [] });

    const updated = await cascadeExportTransactionsStatus(client, "inv-3", "draft");

    expect(updated).toBe(0);
    expect(calls.filters).toEqual([]);
  });

  it("releases unpaid rows back to invoice_required and clears invoice_id when voided", async () => {
    const { client, calls } = exportTransactionsUpdateStub({ returned: [{ id: "t1" }, { id: "t2" }] });

    const updated = await cascadeExportTransactionsStatus(client, "inv-4", "voided");

    expect(updated).toBe(2);
    expect(calls.payload).toEqual({ status: "invoice_required", invoice_id: null });
    expect(calls.filters).toContainEqual({ method: "eq", args: ["invoice_id", "inv-4"] });
  });

  it("only releases rows that are still unpaid, so a full refund's paid rows survive", async () => {
    // REFUNDED maps to `voided` too. Those rows are 'paid' and writeRefundReturn
    // finds them BY invoice_id — releasing them would regress a settled row and
    // orphan the return. The status filter is the only thing separating the two.
    const { client, calls } = exportTransactionsUpdateStub({ returned: [] });

    await cascadeExportTransactionsStatus(client, "inv-5", "voided");

    expect(calls.filters).toContainEqual({ method: "eq", args: ["status", "unpaid"] });
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

  it("reopens the allocation (clears sent_at) when the invoice was deleted in Square", () => {
    // A directly-deleted invoice is terminal like CANCELED/FAILED: clear the
    // sent timestamp so the deposit can be regenerated, never set paid.
    expect(buildAllocationInvoiceTimestamps({
      squareStatus: MISSING_SQUARE_STATUS, ledgerStatus: "voided",
      current: { invoice_sent_at: "s", invoice_paid_at: null }, paidAt: null, updatedAt: null, now: NOW,
    })).toEqual({ invoice_sent_at: null });
  });

  it("does nothing for a deleted invoice whose allocation was never sent", () => {
    expect(buildAllocationInvoiceTimestamps({
      squareStatus: MISSING_SQUARE_STATUS, ledgerStatus: "voided",
      current: unsent, paidAt: null, updatedAt: null, now: NOW,
    })).toEqual({});
  });
});

// ── Orchestrator: deleted-in-Square (404) terminal path ────────────────────────

interface LedgerRow { id: string; raw_data: unknown }
type UpdateSpy = { table: string; payload: Record<string, unknown> };

/**
 * Minimal Supabase stub covering exactly the query chains the 404 void path
 * exercises: an `invoices` select + update, and a `batch_allocations` select.
 * Records every update so tests can assert the real payload written.
 */
function voidPathStub(opts: {
  invoiceRow: LedgerRow | null;
  updates: UpdateSpy[];
  updateError?: string;
}): SupabaseClient {
  const client = {
    from(table: string) {
      const selectData = table === "invoices" ? opts.invoiceRow : null;
      const selectBuilder = {
        select: () => selectBuilder,
        eq: () => selectBuilder,
        maybeSingle: () => Promise.resolve({ data: selectData, error: null }),
      };
      return {
        select: () => selectBuilder,
        update: (payload: Record<string, unknown>) => {
          opts.updates.push({ table, payload });
          const error = opts.updateError ? { message: opts.updateError } : null;
          // `invoices` and `batch_allocations` end at a single .eq(); the
          // export_transactions release chains .eq().eq().select(). Thenable so
          // both shapes resolve off the same object.
          const chain = {
            eq: () => chain,
            select: () => Promise.resolve({ data: [], error }),
            then: (resolve: (v: { error: unknown }) => unknown) => Promise.resolve({ error }).then(resolve),
          };
          return chain;
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

describe("reconcileInvoiceStatus — invoice deleted in Square (404)", () => {
  it("voids the ledger row and returns invoiceMissing instead of throwing", async () => {
    getInvoiceStatus.mockRejectedValueOnce(new SquareApiError(404, "NOT_FOUND", "Invoice not found."));
    const updates: UpdateSpy[] = [];
    const supabase = voidPathStub({ invoiceRow: { id: "inv-1", raw_data: { square_status: "DRAFT" } }, updates });

    const result = await reconcileInvoiceStatus(supabase, "sq-deleted-1");

    expect(result.invoiceMissing).toBe(true);
    expect(result.ledgerStatus).toBe("voided");
    expect(result.squareStatus).toBe(MISSING_SQUARE_STATUS);
    expect(result.updatedLedger).toBe(true);
    // The ledger row is transitioned to 'voided' — which drops it out of the
    // daily cron's ('draft','open','partial') filter so it is never re-hit.
    const ledgerUpdate = updates.find((u) => u.table === "invoices");
    expect(ledgerUpdate?.payload.status).toBe("voided");
    expect((ledgerUpdate?.payload.raw_data as Record<string, unknown>).square_status).toBe(MISSING_SQUARE_STATUS);
  });

  it("skips gracefully (no throw) when the deleted invoice has no ledger row", async () => {
    getInvoiceStatus.mockRejectedValueOnce(new SquareApiError(404, "NOT_FOUND", "Invoice not found."));
    const updates: UpdateSpy[] = [];
    const supabase = voidPathStub({ invoiceRow: null, updates });

    const result = await reconcileInvoiceStatus(supabase, "sq-orphan");

    expect(result.invoiceMissing).toBe(true);
    expect(result.skippedReason).toBe("no-ledger-row");
    expect(result.updatedLedger).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("re-throws non-404 Square failures (transient — cron/webhook should retry)", async () => {
    getInvoiceStatus.mockRejectedValueOnce(new SquareApiError(500, "INTERNAL_SERVER_ERROR", "boom"));
    const updates: UpdateSpy[] = [];
    const supabase = voidPathStub({ invoiceRow: { id: "inv-1", raw_data: {} }, updates });

    await expect(reconcileInvoiceStatus(supabase, "sq-1")).rejects.toThrow("boom");
    expect(updates).toHaveLength(0);
  });
});
