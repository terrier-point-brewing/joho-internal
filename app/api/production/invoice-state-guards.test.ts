import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The invoice state machine's refusals, at the route.
 *
 * Each case is a transition the audit found the routes allowed and should not:
 *   - send against a Square invoice that is CANCELED / FAILED / REFUNDED
 *     (deposit and export) used to be treated as "already published";
 *   - mark_paid on a back-charged deposit, or on a deposit with a live unpaid
 *     Square invoice, recorded the deposit a second time when Square later paid.
 *
 * Supabase is a recording stub: the assertion in every refusal is that NOTHING
 * was written, because that is the whole point of refusing.
 */

// The export send schedules post-response work with `after`, which needs a
// request scope; here it only has to not throw.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

const getInvoiceStatus = vi.fn();
const publishInvoice = vi.fn();
const cancelInvoice = vi.fn();
vi.mock("@/lib/square/square-invoices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/square/square-invoices")>();
  return {
    ...actual,
    getInvoiceStatus: (...a: unknown[]) => getInvoiceStatus(...a),
    publishInvoice: (...a: unknown[]) => publishInvoice(...a),
    cancelInvoice: (...a: unknown[]) => cancelInvoice(...a),
    calculateIngredientDeposit: vi.fn(async () => ({ deposit_cents: 1000, breakdown: [], excluded_recipe_ids: [] })),
  };
});
vi.mock("@/lib/square/client", () => ({
  isSquareNotFound: (e: unknown) => (e as { status?: number } | null)?.status === 404,
}));
vi.mock("@/lib/production/exportIngredientDeposit", () => ({ conversionDepositExclusions: vi.fn(async () => []) }));
vi.mock("@/lib/production/depositBreakdown", () => ({ snapshotDepositBreakdown: vi.fn(async () => undefined) }));
vi.mock("@/lib/production/commitmentFulfillment", () => ({ stampCommitmentLockedOn: vi.fn(async () => undefined) }));
vi.mock("@/lib/finance/reconcileInvoiceStatus", () => ({
  reconcileInvoiceStatus: vi.fn(),
  cascadeExportTransactionsStatus: vi.fn(),
  settleBackchargedDeposits: vi.fn(),
}));
vi.mock("@/lib/finance/persistSquareOrderLines", () => ({ persistSquareOrderLines: vi.fn(async () => ({ fromSquare: true })) }));
vi.mock("@/lib/finance/syncSquareInvoices", () => ({ syncSquareInvoicesForYear: vi.fn() }));
vi.mock("@/lib/production/invoiceSkuSubstitutions", () => ({
  recordInvoiceSkuSubstitutions: vi.fn(),
  restoreSubstitutedInventory: vi.fn(async () => ({ warnings: [] })),
}));
vi.mock("@/lib/production/triggerSquarePush", () => ({ triggerSquarePush: vi.fn() }));
vi.mock("@/lib/production/exportInvoicePreview", () => ({ computeMaterialBreakdownsForTransactions: vi.fn() }));
vi.mock("@/lib/production/materialBreakdownSnapshot", () => ({ snapshotMaterialBreakdown: vi.fn() }));
vi.mock("@/lib/production/invoiceTerms", () => ({ invoiceDraftDates: vi.fn() }));

// ── Recording Supabase stub ──────────────────────────────────────────────────
interface Write { table: string; op: string; payload: unknown }
type Tables = Record<string, { row?: Record<string, unknown> | null; rows?: unknown[] }>;

let tables: Tables = {};
let writes: Write[] = [];

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "or", "neq", "order", "gt"]) b[m] = () => b;
  for (const m of ["update", "upsert", "insert", "delete"]) {
    b[m] = (payload: unknown) => { writes.push({ table, op: m, payload }); return b; };
  }
  b.single = () => {
    const row = tables[table]?.row ?? null;
    return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } });
  };
  b.maybeSingle = () => Promise.resolve({ data: tables[table]?.row ?? null, error: null });
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: tables[table]?.rows ?? [], error: null }).then(res, rej);
  return b;
}
const client = { from: (table: string) => builder(table) };
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => client) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn(() => client) }));

function post(body: unknown) {
  return new NextRequest("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: "alloc-1" }) };

const allocation = (over: Record<string, unknown> = {}) => ({
  id: "alloc-1",
  channel: "contract_brewing",
  percentage: 50,
  batch_id: "batch-1",
  partner_id: "partner-1",
  square_deposit_invoice_id: "sq-dep",
  square_deposit_order_id: "ord-dep",
  invoice_generated_at: "2026-10-01T00:00:00Z",
  invoice_sent_at: null,
  invoice_paid_at: null,
  deposit_backcharged_invoice_id: null,
  deposit_amount_paid_cents: null,
  brew_batches: { id: "batch-1", beer_name: "Epic Hazy", volume_bbl: 20, turns: 1, recipe_id: "r1", expected_delivery_date: null },
  contract_brewing_partners: { id: "partner-1", company_name: "Fortnight", square_customer_id: "cust-1" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  tables = {};
});

// ── Deposit: send ────────────────────────────────────────────────────────────
describe("deposit send — terminal Square states", () => {
  it.each(["CANCELED", "FAILED", "REFUNDED"])("refuses %s with 409 and writes nothing", async (status) => {
    tables = { batch_allocations: { row: allocation() } };
    getInvoiceStatus.mockResolvedValue({ status });
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post({ action: "send" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot be sent/);
    expect(publishInvoice).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("still publishes a DRAFT and stamps it sent", async () => {
    tables = { batch_allocations: { row: allocation() } };
    getInvoiceStatus.mockResolvedValue({ status: "DRAFT" });
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post({ action: "send" }), params);
    expect(res.status).toBe(200);
    expect(publishInvoice).toHaveBeenCalledWith("sq-dep");
    const alloc = writes.find((w) => w.table === "batch_allocations");
    expect((alloc?.payload as { invoice_sent_at: string }).invoice_sent_at).toBeTruthy();
    expect(writes.find((w) => w.table === "invoices")?.payload).toEqual({ status: "open" });
  });
});

// ── Deposit: mark_paid ───────────────────────────────────────────────────────
describe("deposit mark_paid", () => {
  const body = { action: "mark_paid", source: "other", paid_at: "2026-10-10T00:00:00Z", amount_cents: 1000 };

  it("refuses a back-charged deposit — it settles with the export invoice", async () => {
    tables = { batch_allocations: { row: allocation({ deposit_backcharged_invoice_id: "inv-export" }) } };
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post(body), params);
    expect(res.status).toBe(409);
    expect(writes).toEqual([]);
    expect(cancelInvoice).not.toHaveBeenCalled();
  });

  it("cancels a live unpaid Square draft and drops the pointer before recording the payment", async () => {
    tables = {
      batch_allocations: { row: allocation() },
      invoices: { row: { id: "ledger-ext" } },
    };
    getInvoiceStatus.mockResolvedValue({ status: "UNPAID" });
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post(body), params);
    expect(res.status).toBe(200);
    expect(cancelInvoice).toHaveBeenCalledWith("sq-dep");

    // The Square-backed ledger row is voided; the allocation forgets it.
    expect(writes.find((w) => w.table === "invoices" && w.op === "update")?.payload).toEqual({ status: "voided" });
    const alloc = writes.find((w) => w.table === "batch_allocations")?.payload as Record<string, unknown>;
    expect(alloc.square_deposit_invoice_id).toBeNull();
    expect(alloc.square_deposit_order_id).toBeNull();
    expect(alloc.invoice_paid_at).toBe(body.paid_at);
  });

  it("swallows a Square not-found on the stale invoice", async () => {
    tables = { batch_allocations: { row: allocation() }, invoices: { row: { id: "ledger-ext" } } };
    getInvoiceStatus.mockRejectedValue({ status: 404 });
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post(body), params);
    expect(res.status).toBe(200);
    expect(cancelInvoice).not.toHaveBeenCalled();
  });

  it("refuses when Square already holds the payment — that is a sync, not a mark_paid", async () => {
    tables = { batch_allocations: { row: allocation() } };
    getInvoiceStatus.mockResolvedValue({ status: "PAID" });
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post(body), params);
    expect(res.status).toBe(422);
    expect(cancelInvoice).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("records without touching Square when no invoice was ever generated", async () => {
    tables = {
      batch_allocations: { row: allocation({ square_deposit_invoice_id: null, square_deposit_order_id: null, invoice_generated_at: null }) },
      invoices: { row: { id: "ledger-ext" } },
    };
    const { POST } = await import("./allocations/[id]/invoice/route");
    const res = await POST(post(body), params);
    expect(res.status).toBe(200);
    expect(getInvoiceStatus).not.toHaveBeenCalled();
    expect(cancelInvoice).not.toHaveBeenCalled();
  });
});

// ── Export: send ─────────────────────────────────────────────────────────────
describe("export send — terminal Square states", () => {
  const tx = { id: "tx-1", recipient_id: "partner-1", recipient_name: "Fortnight", status: "invoice_required", invoice_id: "inv-1", batch_id: "batch-1", channel: "contract_brewing", recipe_id: "r1", allocation_id: null, volume_bbl: 1 };

  it("refuses a dashboard-cancelled invoice with 409 and leaves the shipments alone", async () => {
    tables = { export_transactions: { rows: [tx] }, invoices: { row: { square_invoice_id: "sq-exp" } } };
    getInvoiceStatus.mockResolvedValue({ status: "CANCELED" });
    const { POST } = await import("./export/invoice/route");
    const res = await POST(post({ action: "send", transactionIds: ["tx-1"] }));
    expect(res.status).toBe(409);
    expect(publishInvoice).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("treats UNPAID as already published and marks the shipments unpaid", async () => {
    tables = { export_transactions: { rows: [tx] }, invoices: { row: { square_invoice_id: "sq-exp" } } };
    getInvoiceStatus.mockResolvedValue({ status: "UNPAID" });
    const { POST } = await import("./export/invoice/route");
    const res = await POST(post({ action: "send", transactionIds: ["tx-1"] }));
    expect(res.status).toBe(200);
    expect(publishInvoice).not.toHaveBeenCalled();
    expect(writes.find((w) => w.table === "export_transactions")?.payload).toEqual({ status: "unpaid" });
  });
});
