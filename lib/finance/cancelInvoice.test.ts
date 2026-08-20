import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const cancelSquareInvoice = vi.fn();
const getInvoiceStatus = vi.fn();
const fetchCurrentCounts = vi.fn();
const reverseSubstitutedInventory = vi.fn();
const cascadeExportTransactionsStatus = vi.fn();

vi.mock("@/lib/square/square-invoices", () => ({
  cancelInvoice: (...a: unknown[]) => cancelSquareInvoice(...a),
  getInvoiceStatus: (...a: unknown[]) => getInvoiceStatus(...a),
}));
vi.mock("@/lib/square/inventory", () => ({
  fetchCurrentCounts: (...a: unknown[]) => fetchCurrentCounts(...a),
}));
vi.mock("@/lib/production/invoiceSkuSubstitutions", () => ({
  reverseSubstitutedInventory: (...a: unknown[]) => reverseSubstitutedInventory(...a),
}));
vi.mock("@/lib/finance/reconcileInvoiceStatus", () => ({
  cascadeExportTransactionsStatus: (...a: unknown[]) => cascadeExportTransactionsStatus(...a),
}));

class SquareApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "SquareApiError";
  }
}
vi.mock("@/lib/square/client", () => ({
  isSquareNotFound: (e: unknown) => e instanceof Error && (e as { status?: number }).status === 404,
}));

import { cancelExportInvoice, CancelInvoiceError } from "./cancelInvoice";

interface InvoiceRow {
  id: string;
  status: string;
  square_invoice_id: string | null;
  invoice_number: string | null;
  invoice_type: string;
}

const invoice = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: "inv-1",
  status: "open",
  square_invoice_id: "sq-1",
  invoice_number: "000051",
  invoice_type: "export_invoice",
  ...over,
});

/**
 * Stub covering only the chains cancelExportInvoice uses: the invoices
 * select/update, the line-item + catalog reads that decide which SKUs Square
 * owes a restock on, and nothing else.
 */
function stub(opts: {
  invoiceRow: InvoiceRow | null;
  lineVariations?: string[];
  trackedVariations?: string[];
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  updateError?: string;
}): SupabaseClient {
  const client = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        in: () => builder,
        single: () =>
          Promise.resolve(
            opts.invoiceRow
              ? { data: opts.invoiceRow, error: null }
              : { data: null, error: { message: "not found" } },
          ),
        // The two list reads resolve off the builder itself.
        then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
          const data =
            table === "invoice_line_items"
              ? (opts.lineVariations ?? []).map((v) => ({ square_catalog_variation_id: v }))
              : table === "square_catalog_variations"
                ? (opts.lineVariations ?? []).map((v) => ({
                    square_variation_id: v,
                    track_inventory: (opts.trackedVariations ?? []).includes(v),
                  }))
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return {
        ...builder,
        update: (payload: Record<string, unknown>) => {
          opts.updates.push({ table, payload });
          return {
            eq: () =>
              Promise.resolve({ error: opts.updateError ? { message: opts.updateError } : null }),
          };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  getInvoiceStatus.mockResolvedValue({ status: "UNPAID" });
  cancelSquareInvoice.mockResolvedValue(undefined);
  fetchCurrentCounts.mockResolvedValue(new Map());
  reverseSubstitutedInventory.mockResolvedValue({ reversed: 0, warnings: [] });
  cascadeExportTransactionsStatus.mockResolvedValue(1);
});

describe("cancelExportInvoice — what it refuses", () => {
  it("requires a reason", async () => {
    const updates: never[] = [];
    await expect(
      cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), { invoiceId: "inv-1", reason: "  " }),
    ).rejects.toThrow(CancelInvoiceError);
    expect(cancelSquareInvoice).not.toHaveBeenCalled();
  });

  it("refuses a PAID invoice and points at Credit Invoice", async () => {
    const updates: never[] = [];
    await expect(
      cancelExportInvoice(stub({ invoiceRow: invoice({ status: "paid" }), updates }), {
        invoiceId: "inv-1",
        reason: "wrong customer",
      }),
    ).rejects.toThrow(/Credit Invoice/);
    // Nothing reached Square: money has changed hands and a cancel would erase
    // the revenue while leaving the payment sitting there.
    expect(cancelSquareInvoice).not.toHaveBeenCalled();
  });

  it("refuses an already-cancelled invoice", async () => {
    const updates: never[] = [];
    await expect(
      cancelExportInvoice(stub({ invoiceRow: invoice({ status: "voided" }), updates }), {
        invoiceId: "inv-1",
        reason: "again",
      }),
    ).rejects.toThrow(/already been cancelled/);
  });

  it("leaves the ledger untouched when Square refuses the cancel", async () => {
    // Square first, precisely so this is recoverable: nothing local moved, and
    // the operator can simply try again.
    cancelSquareInvoice.mockRejectedValueOnce(new Error("VERSION_MISMATCH"));
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    await expect(
      cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), {
        invoiceId: "inv-1",
        reason: "wrong qty",
      }),
    ).rejects.toThrow(/Square would not cancel/);
    expect(updates).toEqual([]);
    expect(cascadeExportTransactionsStatus).not.toHaveBeenCalled();
  });
});

describe("cancelExportInvoice — what it does", () => {
  it("voids the ledger with the reason and releases the shipments", async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const result = await cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), {
      invoiceId: "inv-1",
      reason: "wrong quantity",
      userId: "ops@example.com",
    });

    const voidWrite = updates.find((u) => u.table === "invoices");
    expect(voidWrite?.payload.status).toBe("voided");
    expect(voidWrite?.payload.voided_reason).toBe("wrong quantity");
    expect(voidWrite?.payload.voided_at).toBeTruthy();

    // Through the SHARED cascade, so a cancel done in the Square dashboard
    // reaches identical behaviour via reconcileInvoiceStatus.
    expect(cascadeExportTransactionsStatus).toHaveBeenCalledWith(expect.anything(), "inv-1", "voided");
    expect(result.releasedShipments).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("does not touch cold storage, allocations or excise", async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    await cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), {
      invoiceId: "inv-1",
      reason: "wrong customer",
    });
    // The beer still shipped. Cancelling the bill is not un-shipping, and a
    // silent restock here would be an inventory write nobody asked for.
    expect(updates.map((u) => u.table)).toEqual(["invoices"]);
  });

  it("takes back substitution credits so Square is not left over-counted", async () => {
    reverseSubstitutedInventory.mockResolvedValueOnce({ reversed: 2, warnings: [] });
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const result = await cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), {
      invoiceId: "inv-1",
      reason: "wrong customer",
    });
    expect(result.reversedSubstitutions).toBe(2);
  });

  it("warns when Square's count did not rise, because re-invoicing would deduct twice", async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    // Same count before and after: Square did not put the units back.
    fetchCurrentCounts.mockResolvedValue(new Map([["sq-var-1", 111]]));

    const result = await cancelExportInvoice(
      stub({
        invoiceRow: invoice(),
        lineVariations: ["sq-var-1"],
        trackedVariations: ["sq-var-1"],
        updates,
      }),
      { invoiceId: "inv-1", reason: "wrong qty" },
    );

    expect(result.warnings.join(" ")).toMatch(/deduct the same units a second time/);
    // Still cancelled — the invoice is dead in Square and saying otherwise
    // would be false.
    expect(updates.find((u) => u.table === "invoices")?.payload.status).toBe("voided");
  });

  it("treats an invoice already gone from Square as a repair, not an error", async () => {
    const err = new SquareApiError(404, "NOT_FOUND", "Invoice not found.");
    getInvoiceStatus.mockRejectedValueOnce(err);
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];

    const result = await cancelExportInvoice(stub({ invoiceRow: invoice(), updates }), {
      invoiceId: "inv-1",
      reason: "already killed in the dashboard",
    });

    expect(result.warnings.join(" ")).toMatch(/no longer existed in Square/);
    expect(updates.find((u) => u.table === "invoices")?.payload.status).toBe("voided");
    expect(cascadeExportTransactionsStatus).toHaveBeenCalled();
  });

  it("warns that a non-Square invoice must be cancelled where it was issued", async () => {
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const result = await cancelExportInvoice(
      stub({ invoiceRow: invoice({ square_invoice_id: null }), updates }),
      { invoiceId: "inv-1", reason: "duplicate" },
    );
    expect(result.warnings.join(" ")).toMatch(/system that issued it/);
    expect(cancelSquareInvoice).not.toHaveBeenCalled();
    // Local void still happens — the ledger row is ours to correct.
    expect(updates.find((u) => u.table === "invoices")?.payload.status).toBe("voided");
  });
});
