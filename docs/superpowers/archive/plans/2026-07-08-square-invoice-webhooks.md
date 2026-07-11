# Square Invoice Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically capture Square invoice status changes (sent/paid/canceled) via webhooks so the finance ledger, export transactions, and deposit allocations update without a manual Sync click — and stop the year-sync from wiping manual account mappings.

**Architecture:** One shared, idempotent `reconcileInvoiceStatus(supabase, squareInvoiceId)` refetches an invoice from Square and updates all three consumers. It becomes the single code path for the `invoice.*` webhook, the two manual "sync" actions, and a new daily cron safety-net. Decision logic is extracted into pure functions (tested directly, matching the `normalizeRefund`/`buildRefundRow` pattern); the orchestrator does the IO. A separate bug fix makes the year-sync preserve existing line-item COA mappings on re-sync.

**Tech Stack:** Next.js 16 (App Router, route handlers), TypeScript, Supabase Postgres (raw `@supabase/supabase-js`), Square API via `lib/square/client.ts` (raw fetch), Vitest.

## Global Constraints

- No business logic in `app/api/**` or page components — extract to `lib/`.
- New/modified `lib/` modules ship co-located `*.test.ts` covering pure logic; CI runs `npm run test` (`vitest run`). Don't drop `lib/` coverage below the `vitest.config.ts` floor.
- Square API version `2025-04-16`; single location `LZ8TH4A632YW0`. Auth/base URL handled by `lib/square/client.ts` — reuse `squareGet`/`squarePost`, never re-implement.
- Reuse existing tables/columns — no new migration in this plan (all columns exist).
- Ledger `InvoiceStatus = "open" | "paid" | "voided" | "partial" | "unknown" | "draft"` (from `types/finance.ts`).
- Webhook auth is the HMAC signature only; verify raw body before parsing. Ack 200 immediately, reconcile in `after()`.
- No raw Tailwind colors in any UI touched (none expected here).

---

## File Structure

Create:
- `lib/finance/invoiceStatus.ts` — pure Square→ledger status mapper (+ `invoiceStatus.test.ts`).
- `lib/finance/reconcileInvoiceStatus.ts` — pure decision helpers + IO orchestrator (+ `reconcileInvoiceStatus.test.ts`).
- `lib/finance/syncSquareInvoices.test.ts` — TDD for the COA-preservation fix.

Modify:
- `lib/square/square-invoices.ts` — `getInvoiceStatus` also returns `updatedAt`.
- `lib/square/webhook.ts` — add `isInvoiceEvent` + `extractSquareInvoiceId` (+ extend `webhook.test.ts`).
- `lib/finance/syncSquareInvoices.ts` — use shared mapper; preserve COA mappings via `resolveLineItemCoa`.
- `app/api/webhooks/square/route.ts` — admit + dispatch `invoice.*`.
- `app/api/production/export/invoice/route.ts` — `sync` action calls the orchestrator.
- `app/api/production/allocations/[id]/invoice/route.ts` — `sync` action calls the orchestrator; delete local `mapSquareStatus`.
- `app/api/cron/finance-sync/route.ts` — reconcile non-terminal invoices.

---

## Task 1: Shared Square→ledger status mapper

**Files:**
- Create: `lib/finance/invoiceStatus.ts`
- Test: `lib/finance/invoiceStatus.test.ts`
- Modify: `lib/finance/syncSquareInvoices.ts` (replace local `squareStatusToLedger`)

**Interfaces:**
- Produces: `mapSquareInvoiceStatus(squareStatus: string): InvoiceStatus`

- [ ] **Step 1: Write the failing test**

Create `lib/finance/invoiceStatus.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapSquareInvoiceStatus } from "./invoiceStatus";

describe("mapSquareInvoiceStatus", () => {
  it("maps each Square status to the unified ledger status", () => {
    expect(mapSquareInvoiceStatus("DRAFT")).toBe("draft");
    expect(mapSquareInvoiceStatus("UNPAID")).toBe("open");
    expect(mapSquareInvoiceStatus("SCHEDULED")).toBe("open");
    expect(mapSquareInvoiceStatus("PARTIALLY_PAID")).toBe("partial");
    expect(mapSquareInvoiceStatus("PAID")).toBe("paid");
    expect(mapSquareInvoiceStatus("PARTIALLY_REFUNDED")).toBe("paid");
    expect(mapSquareInvoiceStatus("CANCELED")).toBe("voided");
    expect(mapSquareInvoiceStatus("REFUNDED")).toBe("voided");
    expect(mapSquareInvoiceStatus("FAILED")).toBe("voided");
  });

  it("is case-insensitive", () => {
    expect(mapSquareInvoiceStatus("paid")).toBe("paid");
  });

  it("returns 'unknown' for anything unexpected", () => {
    expect(mapSquareInvoiceStatus("WHATEVER")).toBe("unknown");
    expect(mapSquareInvoiceStatus("")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/invoiceStatus.test.ts`
Expected: FAIL — cannot find module `./invoiceStatus`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/finance/invoiceStatus.ts`:

```ts
import type { InvoiceStatus } from "@/types/finance";

/**
 * Single source of truth for mapping a Square invoice status to our ledger
 * `InvoiceStatus`. Consolidates the previously-duplicated mappers in
 * syncSquareInvoices, the deposit route, and the export route so they never
 * drift. A fully-refunded invoice is `voided`; a partial refund stays `paid`
 * (the refunded dollars are tracked separately by the refund sync).
 */
export function mapSquareInvoiceStatus(squareStatus: string): InvoiceStatus {
  switch (squareStatus.toUpperCase()) {
    case "DRAFT":                       return "draft";
    case "UNPAID":
    case "SCHEDULED":                   return "open";
    case "PARTIALLY_PAID":              return "partial";
    case "PAID":
    case "PARTIALLY_REFUNDED":          return "paid";
    case "CANCELED":
    case "REFUNDED":
    case "FAILED":                      return "voided";
    default:                            return "unknown";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/finance/invoiceStatus.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Replace the local mapper in syncSquareInvoices**

In `lib/finance/syncSquareInvoices.ts`:
- Delete the `squareStatusToLedger` function (lines ~11-21).
- Add import near the other `lib/finance` imports:

```ts
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
```

- Replace the call site `const status = squareStatusToLedger(inv.status);` with:

```ts
const status = mapSquareInvoiceStatus(inv.status);
```

- `squareStatusToLedger` was the only user of the `InvoiceStatus` type in this file. After deleting it, drop `InvoiceStatus` from the finance types import so lint doesn't flag it as unused:

```ts
import type { InvoiceLineCategory } from "@/types/finance";
```

- [ ] **Step 6: Verify the whole suite still passes**

Run: `npm run test`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add lib/finance/invoiceStatus.ts lib/finance/invoiceStatus.test.ts lib/finance/syncSquareInvoices.ts
git commit -m "feat(finance): shared Square->ledger invoice status mapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Preserve line-item COA mappings on invoice re-sync (bug fix)

**Files:**
- Modify: `lib/finance/syncSquareInvoices.ts`
- Test: `lib/finance/syncSquareInvoices.test.ts` (new)

**Interfaces:**
- Produces: `resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa` and `interface LineItemCoa { chart_of_accounts_id: string | null; bs_chart_of_accounts_id: string | null; pl_chart_of_accounts_id: string | null }`

**Background:** the `invoice_line_items` upsert (`onConflict: "invoice_id,sort_order"`) currently writes the three COA columns from the *current variation mapping or null*, so `ON CONFLICT DO UPDATE` overwrites a user's manual/auto-mapped account on every re-sync. Fix: existing value wins; the variation prefill only fills gaps.

- [ ] **Step 1: Write the failing test**

Create `lib/finance/syncSquareInvoices.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveLineItemCoa, type LineItemCoa } from "./syncSquareInvoices";

const NONE: LineItemCoa = {
  chart_of_accounts_id: null,
  bs_chart_of_accounts_id: null,
  pl_chart_of_accounts_id: null,
};

describe("resolveLineItemCoa", () => {
  it("keeps an existing manual mapping even when the variation prefill is null", () => {
    const existing: LineItemCoa = { chart_of_accounts_id: "COA_MANUAL", bs_chart_of_accounts_id: null, pl_chart_of_accounts_id: null };
    expect(resolveLineItemCoa(existing, NONE)).toEqual(existing);
  });

  it("keeps an existing mapping even when the variation prefill differs", () => {
    const existing: LineItemCoa = { chart_of_accounts_id: "COA_MANUAL", bs_chart_of_accounts_id: "BS_MANUAL", pl_chart_of_accounts_id: null };
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT", bs_chart_of_accounts_id: "BS_DEFAULT", pl_chart_of_accounts_id: "PL_DEFAULT" };
    expect(resolveLineItemCoa(existing, prefill)).toEqual({
      chart_of_accounts_id: "COA_MANUAL",
      bs_chart_of_accounts_id: "BS_MANUAL",
      pl_chart_of_accounts_id: "PL_DEFAULT", // gap filled from prefill
    });
  });

  it("prefills a brand-new line item (no existing row) from the variation", () => {
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT", bs_chart_of_accounts_id: null, pl_chart_of_accounts_id: null };
    expect(resolveLineItemCoa(undefined, prefill)).toEqual(prefill);
  });

  it("prefills a still-null existing item from the variation", () => {
    const prefill: LineItemCoa = { chart_of_accounts_id: "COA_DEFAULT", bs_chart_of_accounts_id: null, pl_chart_of_accounts_id: null };
    expect(resolveLineItemCoa(NONE, prefill)).toEqual(prefill);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/finance/syncSquareInvoices.test.ts`
Expected: FAIL — `resolveLineItemCoa` is not exported.

- [ ] **Step 3: Add the pure helper**

In `lib/finance/syncSquareInvoices.ts`, add near the top (after imports, before `squareStatusToLedger`'s former location):

```ts
export interface LineItemCoa {
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
}

/**
 * Chart-of-accounts values to write for a line item on (re-)sync. An existing
 * non-null mapping (user-set or auto-mapped) always wins; the variation prefill
 * only fills gaps. This makes re-syncs non-destructive — matching the app's
 * fill-nulls-only mapping convention (invoices/auto-map, expenses/auto-map).
 */
export function resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa {
  return {
    chart_of_accounts_id:    existing?.chart_of_accounts_id    ?? prefill.chart_of_accounts_id,
    bs_chart_of_accounts_id: existing?.bs_chart_of_accounts_id ?? prefill.bs_chart_of_accounts_id,
    pl_chart_of_accounts_id: existing?.pl_chart_of_accounts_id ?? prefill.pl_chart_of_accounts_id,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/finance/syncSquareInvoices.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the helper into the upsert loop**

In `lib/finance/syncSquareInvoices.ts`, inside the `for (const inv of squareInvoices)` loop, **after** the `invoices` upsert produces `invRow` and **before** the `(order.line_items ?? []).forEach(...)` block, load existing COA mappings for this invoice (place it right after the `lineItems` array is declared):

```ts
    // Load existing COA mappings so a re-sync never wipes a manual/auto-mapped
    // account — the upsert below would otherwise overwrite these columns.
    const { data: existingLines } = await supabase
      .from("invoice_line_items")
      .select("sort_order, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
      .eq("invoice_id", invRow.id);
    const existingCoaBySort = new Map<number, LineItemCoa>(
      (existingLines ?? []).map((r) => [
        r.sort_order as number,
        {
          chart_of_accounts_id:    r.chart_of_accounts_id,
          bs_chart_of_accounts_id: r.bs_chart_of_accounts_id,
          pl_chart_of_accounts_id: r.pl_chart_of_accounts_id,
        },
      ]),
    );
```

Then in the `forEach((li, i) => { ... })`, replace the three inline COA assignments in the `lineItems.push({...})` with a resolved object. Change:

```ts
      const varMapping = varId ? variationById.get(varId) : undefined;
      lineItems.push({
        invoice_id:              invRow.id,
        sort_order:              i,
        description:             li.name + (varName ? ` — ${varName}` : ""),
        category,
        quantity:                qty,
        unit_price_cents:        li.base_price_money?.amount ?? 0,
        total_cents:             li.total_money?.amount ?? 0,
        variation_name:          varName || null,
        chart_of_accounts_id:    varMapping?.chart_of_accounts_id_invoice ?? null,
        bs_chart_of_accounts_id: varMapping?.bs_chart_of_accounts_id ?? null,
        pl_chart_of_accounts_id: varMapping?.pl_chart_of_accounts_id ?? null,
        raw_data: {
```

to:

```ts
      const varMapping = varId ? variationById.get(varId) : undefined;
      const coa = resolveLineItemCoa(existingCoaBySort.get(i), {
        chart_of_accounts_id:    varMapping?.chart_of_accounts_id_invoice ?? null,
        bs_chart_of_accounts_id: varMapping?.bs_chart_of_accounts_id ?? null,
        pl_chart_of_accounts_id: varMapping?.pl_chart_of_accounts_id ?? null,
      });
      lineItems.push({
        invoice_id:              invRow.id,
        sort_order:              i,
        description:             li.name + (varName ? ` — ${varName}` : ""),
        category,
        quantity:                qty,
        unit_price_cents:        li.base_price_money?.amount ?? 0,
        total_cents:             li.total_money?.amount ?? 0,
        variation_name:          varName || null,
        chart_of_accounts_id:    coa.chart_of_accounts_id,
        bs_chart_of_accounts_id: coa.bs_chart_of_accounts_id,
        pl_chart_of_accounts_id: coa.pl_chart_of_accounts_id,
        raw_data: {
```

(Leave the rest of the `push` — `raw_data` — unchanged.)

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm run test`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/finance/syncSquareInvoices.ts lib/finance/syncSquareInvoices.test.ts
git commit -m "fix(finance): invoice re-sync no longer wipes manual COA mappings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Invoice webhook event helpers

**Files:**
- Modify: `lib/square/webhook.ts`
- Test: `lib/square/webhook.test.ts` (extend)

**Interfaces:**
- Produces: `isInvoiceEvent(type: unknown): boolean`, `extractSquareInvoiceId(event: unknown): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `lib/square/webhook.test.ts` (and add the two names to the top `import { ... } from "./webhook";`):

```ts
describe("isInvoiceEvent", () => {
  it("is true only for invoice.* events", () => {
    expect(isInvoiceEvent("invoice.published")).toBe(true);
    expect(isInvoiceEvent("invoice.payment_made")).toBe(true);
    expect(isInvoiceEvent("invoice.canceled")).toBe(true);
    expect(isInvoiceEvent("order.updated")).toBe(false);
    expect(isInvoiceEvent("refund.created")).toBe(false);
    expect(isInvoiceEvent(undefined)).toBe(false);
    expect(isInvoiceEvent(7)).toBe(false);
  });
});

describe("extractSquareInvoiceId", () => {
  it("reads the invoice id from data.object.invoice.id (canonical shape)", () => {
    const event = {
      type: "invoice.payment_made",
      data: {
        type: "invoice",
        id: "INV_ABC",
        object: { invoice: { id: "INV_ABC", status: "PAID" } },
      },
    };
    expect(extractSquareInvoiceId(event)).toBe("INV_ABC");
  });

  it("falls back to data.id when object.invoice.id is absent", () => {
    expect(extractSquareInvoiceId({ data: { id: "INV_FALLBACK" } })).toBe("INV_FALLBACK");
  });

  it("returns null for malformed or non-invoice payloads", () => {
    expect(extractSquareInvoiceId(null)).toBeNull();
    expect(extractSquareInvoiceId(undefined)).toBeNull();
    expect(extractSquareInvoiceId({})).toBeNull();
    expect(extractSquareInvoiceId({ data: {} })).toBeNull();
    expect(extractSquareInvoiceId({ data: { id: "" } })).toBeNull();
    expect(extractSquareInvoiceId({ data: { object: { invoice: {} } } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/square/webhook.test.ts`
Expected: FAIL — `isInvoiceEvent` / `extractSquareInvoiceId` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `lib/square/webhook.ts`:

```ts
/** Whether an event type is a Square invoice event (`invoice.*`). */
export function isInvoiceEvent(type: unknown): boolean {
  return typeof type === "string" && type.startsWith("invoice.");
}

/**
 * Pull the affected invoice id out of a Square `invoice.*` webhook event so we
 * can refetch and reconcile just that invoice. Square nests it at
 * `data.object.invoice.id`; we fall back to `data.id`. Returns null if no
 * invoice id is present (a non-invoice event or unexpected payload).
 */
export function extractSquareInvoiceId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;

  const obj = (data as { object?: unknown }).object;
  if (obj && typeof obj === "object") {
    const invoice = (obj as { invoice?: unknown }).invoice;
    if (invoice && typeof invoice === "object") {
      const id = (invoice as { id?: unknown }).id;
      if (typeof id === "string" && id) return id;
    }
  }

  const dataId = (data as { id?: unknown }).id;
  if (typeof dataId === "string" && dataId) return dataId;

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/square/webhook.test.ts`
Expected: PASS (all, including new describes).

- [ ] **Step 5: Commit**

```bash
git add lib/square/webhook.ts lib/square/webhook.test.ts
git commit -m "feat(square): invoice webhook event helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `getInvoiceStatus` returns `updatedAt` + reconcile pure helpers

**Files:**
- Modify: `lib/square/square-invoices.ts` (`getInvoiceStatus`)
- Create: `lib/finance/reconcileInvoiceStatus.ts` (pure helpers only in this task)
- Test: `lib/finance/reconcileInvoiceStatus.test.ts`

**Interfaces:**
- Consumes: `mapSquareInvoiceStatus` (Task 1); `InvoiceStatus` from `types/finance.ts`.
- Produces:
  - `getInvoiceStatus(...)` now returns `{ status, paidAt, updatedAt, version, publicUrl, invoiceNumber }` (adds `updatedAt: string | null`).
  - `exportStatusForLedger(ledger: InvoiceStatus): "paid" | "unpaid" | null`
  - `interface AllocationInvoiceState { invoice_sent_at: string | null; invoice_paid_at: string | null }`
  - `interface AllocationInvoiceTimestamps { invoice_sent_at?: string | null; invoice_paid_at?: string | null }`
  - `buildAllocationInvoiceTimestamps(params: { squareStatus: string; ledgerStatus: InvoiceStatus; current: AllocationInvoiceState; paidAt: string | null; updatedAt: string | null; now: string }): AllocationInvoiceTimestamps`

- [ ] **Step 1: Extend `getInvoiceStatus`**

In `lib/square/square-invoices.ts`, change `getInvoiceStatus` (currently returns without `updatedAt`) to:

```ts
/** Fetches the current status of an invoice from Square. */
export async function getInvoiceStatus(
  invoiceId: string
): Promise<{ status: string; paidAt: string | null; updatedAt: string | null; version: number; publicUrl: string | null; invoiceNumber: string | null }> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  const isPaid = invoice.status === "PAID";
  return {
    status: invoice.status,
    paidAt: isPaid ? (invoice.updated_at ?? new Date().toISOString()) : null,
    updatedAt: invoice.updated_at ?? null,
    version: invoice.version,
    publicUrl: invoice.public_url ?? null,
    invoiceNumber: invoice.invoice_number ?? null,
  };
}
```

(`SquareInvoiceGetResponse` already includes `updated_at?: string`.)

- [ ] **Step 2: Write the failing test for the pure helpers**

Create `lib/finance/reconcileInvoiceStatus.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/finance/reconcileInvoiceStatus.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 4: Implement the pure helpers**

Create `lib/finance/reconcileInvoiceStatus.ts` with ONLY the pure helpers for now (the orchestrator lands in Task 5):

```ts
import type { InvoiceStatus } from "@/types/finance";

/**
 * Target `export_transactions.status` for a given ledger status, or null when
 * the status should not touch export transactions. `paid` settles the invoice's
 * lines; `open`/`partial` mean it's out (unpaid). draft/voided/unknown are
 * left alone (the orchestrator never regresses a paid row).
 */
export function exportStatusForLedger(ledger: InvoiceStatus): "paid" | "unpaid" | null {
  if (ledger === "paid") return "paid";
  if (ledger === "open" || ledger === "partial") return "unpaid";
  return null;
}

export interface AllocationInvoiceState {
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
}

export interface AllocationInvoiceTimestamps {
  invoice_sent_at?: string | null;
  invoice_paid_at?: string | null;
}

const SQUARE_TERMINAL_FAILURE = new Set(["CANCELED", "FAILED"]);

/**
 * Compute the deposit-allocation timestamp changes for a reconcile. Pure — the
 * orchestrator applies the returned patch and separately captures the payment
 * reference. Rules:
 *  - CANCELED/FAILED  → clear invoice_sent_at (reopen for regeneration)
 *  - past DRAFT & not yet sent → set invoice_sent_at (published = sent)
 *  - paid & not yet paid       → set invoice_paid_at
 * An empty object means nothing changed (idempotent re-delivery).
 */
export function buildAllocationInvoiceTimestamps(params: {
  squareStatus: string;
  ledgerStatus: InvoiceStatus;
  current: AllocationInvoiceState;
  paidAt: string | null;
  updatedAt: string | null;
  now: string;
}): AllocationInvoiceTimestamps {
  const { squareStatus, ledgerStatus, current, paidAt, updatedAt, now } = params;
  const patch: AllocationInvoiceTimestamps = {};
  const sq = squareStatus.toUpperCase();

  if (SQUARE_TERMINAL_FAILURE.has(sq)) {
    if (current.invoice_sent_at !== null) patch.invoice_sent_at = null;
    return patch;
  }

  // Any state past DRAFT means the invoice was published (sent).
  if (sq !== "DRAFT" && !current.invoice_sent_at) {
    patch.invoice_sent_at = updatedAt ?? now;
  }

  if (ledgerStatus === "paid" && !current.invoice_paid_at) {
    patch.invoice_paid_at = paidAt ?? now;
  }

  return patch;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/finance/reconcileInvoiceStatus.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (getInvoiceStatus callers still compile)**

Run: `npx tsc --noEmit`
Expected: no errors (adding a field to the return type is backward-compatible).

- [ ] **Step 7: Commit**

```bash
git add lib/square/square-invoices.ts lib/finance/reconcileInvoiceStatus.ts lib/finance/reconcileInvoiceStatus.test.ts
git commit -m "feat(finance): reconcile decision helpers + getInvoiceStatus updatedAt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `reconcileInvoiceStatus` orchestrator (IO)

**Files:**
- Modify: `lib/finance/reconcileInvoiceStatus.ts` (add the orchestrator + result type)

**Interfaces:**
- Consumes: `getInvoiceStatus`, `getOrderPayment` (`lib/square/square-invoices.ts`); `mapSquareInvoiceStatus` (Task 1); the pure helpers from Task 4; a Supabase admin client.
- Produces:
  - `interface ReconcileInvoiceStatusResult { squareInvoiceId: string; squareStatus: string; ledgerStatus: InvoiceStatus; updatedLedger: boolean; updatedExportTransactions: number; updatedAllocation: boolean; paymentCaptured: boolean; skippedReason?: "no-ledger-row" }`
  - `reconcileInvoiceStatus(supabase: SupabaseClient, squareInvoiceId: string): Promise<ReconcileInvoiceStatusResult>`

**Note on testing:** the orchestrator is IO-heavy (Square + Supabase). Its decision logic is already covered by the Task 4 pure helpers; per the codebase convention (`syncRefunds` orchestrator is not unit-mocked) we verify it via typecheck + the integration tasks that follow. No new mocked test here.

- [ ] **Step 1: Add imports at the top of `lib/finance/reconcileInvoiceStatus.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInvoiceStatus, getOrderPayment } from "@/lib/square/square-invoices";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
```

(Keep the existing `import type { InvoiceStatus } from "@/types/finance";`.)

- [ ] **Step 2: Append the result type and orchestrator**

```ts
export interface ReconcileInvoiceStatusResult {
  squareInvoiceId: string;
  squareStatus: string;
  ledgerStatus: InvoiceStatus;
  updatedLedger: boolean;
  updatedExportTransactions: number;
  updatedAllocation: boolean;
  paymentCaptured: boolean;
  skippedReason?: "no-ledger-row";
}

/**
 * Reconcile one Square invoice's status into every consumer that tracks it:
 * the finance ledger (`invoices`), export transactions (`export_transactions`
 * via invoice_id), and deposit allocations (`batch_allocations` via
 * `square_deposit_invoice_id`). Refetches from Square (source of truth) rather
 * than trusting a webhook payload. Idempotent — safe to call repeatedly and
 * from the webhook, the manual sync actions, and the daily cron.
 *
 * `supabase` must be an admin client (cross-table writes, server-side).
 */
export async function reconcileInvoiceStatus(
  supabase: SupabaseClient,
  squareInvoiceId: string,
): Promise<ReconcileInvoiceStatusResult> {
  const sq = await getInvoiceStatus(squareInvoiceId);
  const ledgerStatus = mapSquareInvoiceStatus(sq.status);
  const now = new Date().toISOString();

  const base: ReconcileInvoiceStatusResult = {
    squareInvoiceId,
    squareStatus: sq.status,
    ledgerStatus,
    updatedLedger: false,
    updatedExportTransactions: 0,
    updatedAllocation: false,
    paymentCaptured: false,
  };

  // ── Finance ledger ─────────────────────────────────────────────────────────
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, raw_data")
    .eq("source", "square")
    .eq("square_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (!inv) {
    console.warn("[reconcileInvoiceStatus] no ledger row for invoice", { squareInvoiceId, squareStatus: sq.status });
    return { ...base, skippedReason: "no-ledger-row" };
  }

  const rawData = { ...(inv.raw_data as Record<string, unknown> | null ?? {}), square_status: sq.status, updated_at: sq.updatedAt, paid_at: sq.paidAt };
  const { error: ledgerErr } = await supabase
    .from("invoices")
    .update({
      status: ledgerStatus,
      ...(sq.invoiceNumber ? { invoice_number: sq.invoiceNumber } : {}),
      raw_data: rawData,
    })
    .eq("id", inv.id);
  if (ledgerErr) throw new Error(`ledger update failed: ${ledgerErr.message}`);
  base.updatedLedger = true;

  // ── Export transactions (invoice_id FK) ──────────────────────────────────────
  const exportTarget = exportStatusForLedger(ledgerStatus);
  if (exportTarget === "paid") {
    const { data } = await supabase
      .from("export_transactions")
      .update({ status: "paid" })
      .eq("invoice_id", inv.id)
      .neq("status", "paid")
      .select("id");
    base.updatedExportTransactions = data?.length ?? 0;
  } else if (exportTarget === "unpaid") {
    // Advance invoice_required → unpaid on publish; never regress a paid row.
    const { data } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .eq("invoice_id", inv.id)
      .eq("status", "invoice_required")
      .select("id");
    base.updatedExportTransactions = data?.length ?? 0;
  }

  // ── Deposit allocation (square_deposit_invoice_id) ───────────────────────────
  const { data: alloc } = await supabase
    .from("batch_allocations")
    .select("id, invoice_sent_at, invoice_paid_at, square_payment_id, square_deposit_order_id")
    .eq("square_deposit_invoice_id", squareInvoiceId)
    .maybeSingle();

  if (alloc) {
    const patch: Record<string, unknown> = { ...buildAllocationInvoiceTimestamps({
      squareStatus: sq.status,
      ledgerStatus,
      current: { invoice_sent_at: alloc.invoice_sent_at, invoice_paid_at: alloc.invoice_paid_at },
      paidAt: sq.paidAt,
      updatedAt: sq.updatedAt,
      now,
    }) };

    // Capture the payment reference the first time we record payment — the only
    // point Square exposes it; required for later refunds.
    const newlyPaid = patch.invoice_paid_at != null;
    if (newlyPaid && !alloc.square_payment_id && alloc.square_deposit_order_id) {
      const { paymentId, amountPaidCents } = await getOrderPayment(alloc.square_deposit_order_id);
      if (paymentId) {
        patch.square_payment_id = paymentId;
        patch.deposit_amount_paid_cents = amountPaidCents;
        base.paymentCaptured = true;
      } else {
        console.error(`[reconcileInvoiceStatus] allocation ${alloc.id}: invoice PAID but no Square payment_id on order ${alloc.square_deposit_order_id} — refunds unavailable until manually resolved.`);
      }
    }

    if (Object.keys(patch).length > 0) {
      const { error: allocErr } = await supabase.from("batch_allocations").update(patch).eq("id", alloc.id);
      if (allocErr) throw new Error(`allocation update failed: ${allocErr.message}`);
      base.updatedAllocation = true;
    }
  }

  return base;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full suite (pure-helper tests still green)**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/reconcileInvoiceStatus.ts
git commit -m "feat(finance): reconcileInvoiceStatus orchestrator across all consumers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Dispatch `invoice.*` events in the Square webhook route

**Files:**
- Modify: `app/api/webhooks/square/route.ts`

**Interfaces:**
- Consumes: `isInvoiceEvent`, `extractSquareInvoiceId` (Task 3); `reconcileInvoiceStatus` (Task 5).

- [ ] **Step 1: Update imports**

In `app/api/webhooks/square/route.ts`, extend the two imports:

```ts
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
import {
  verifySquareSignature,
  isFinanceSyncableEvent,
  isRefundEvent,
  isInvoiceEvent,
  extractSquareOrderId,
  extractSquareInvoiceId,
  extractSquareRefund,
} from "@/lib/square/webhook";
```

- [ ] **Step 2: Widen the actionable-event gate**

Replace:

```ts
  if (!isFinanceSyncableEvent(event.type)) {
    return NextResponse.json({ ignored: true, type: event.type ?? null });
  }
```

with:

```ts
  const invoiceEvent = isInvoiceEvent(event.type);
  if (!isFinanceSyncableEvent(event.type) && !invoiceEvent) {
    return NextResponse.json({ ignored: true, type: event.type ?? null });
  }
```

- [ ] **Step 3: Add the invoice branch inside `after()`**

At the very top of the `after(async () => { ... })` body, right after `const supabase = createSupabaseAdminClient();`, add:

```ts
    // Invoice events → reconcile that one invoice's status across the ledger,
    // export transactions, and deposit allocations. Separate from order/refund
    // handling below.
    if (invoiceEvent) {
      const invoiceId = extractSquareInvoiceId(event);
      if (invoiceId) {
        try {
          const result = await reconcileInvoiceStatus(supabase, invoiceId);
          console.log("[square-webhook] invoice reconcile", {
            type: event.type,
            invoiceId,
            ledgerStatus: result.ledgerStatus,
            updatedExportTransactions: result.updatedExportTransactions,
            updatedAllocation: result.updatedAllocation,
            paymentCaptured: result.paymentCaptured,
            skipped: result.skippedReason ?? null,
          });
        } catch (e) {
          console.error("[square-webhook] invoice reconcile failed", e);
        }
      }
      return;
    }
```

- [ ] **Step 4: Typecheck + lint + build**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run lint`
Expected: no errors in the touched file.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/square/route.ts
git commit -m "feat(webhooks): reconcile invoice status on Square invoice.* events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Refactor export invoice `sync` to use the orchestrator

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `reconcileInvoiceStatus` (Task 5).

- [ ] **Step 1: Update imports**

In `app/api/production/export/invoice/route.ts`:
- Add: `import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";`
- Leave `getInvoiceStatus` and `publishInvoice` (both still used by the `send` action) and `syncSquareInvoicesForYear` (still used by `send`) imports as-is.

- [ ] **Step 2: Replace the `sync` action body**

Replace the entire `if (action === "sync") { ... }` block (the one that calls `getInvoiceStatus` then conditionally flips `export_transactions`/`invoices` to paid and calls `syncSquareInvoicesForYear`) with:

```ts
  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    const invoiceId = txs[0].invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }
    if (txs.some((t) => t.invoice_id !== invoiceId)) {
      return NextResponse.json({ error: "Selected transactions belong to different invoices" }, { status: 400 });
    }

    const { data: inv, error: invLookupErr } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("id", invoiceId)
      .single();
    if (invLookupErr || !inv?.square_invoice_id) {
      return NextResponse.json({ error: "Invoice record not found or missing Square ID" }, { status: 400 });
    }

    const result = await reconcileInvoiceStatus(supabase, inv.square_invoice_id as string);
    return NextResponse.json({ squareStatus: result.squareStatus });
  }
```

(The orchestrator now updates `invoices.status` and every `export_transactions` row on the invoice — no more selected-subset update and no full-year re-sync on the sync path.)

- [ ] **Step 3: Typecheck + lint + build**

Run: `npx tsc --noEmit`
Expected: no errors (`getInvoiceStatus` stays imported — the `send` action still uses it).
Run: `npm run lint`
Expected: no unused-import or other errors in the file.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "refactor(export): sync action delegates to reconcileInvoiceStatus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Refactor deposit allocation `sync` to use the orchestrator

**Files:**
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`

**Interfaces:**
- Consumes: `reconcileInvoiceStatus` (Task 5).

- [ ] **Step 1: Update imports**

In `app/api/production/allocations/[id]/invoice/route.ts`:
- Add: `import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";`
- Keep `getInvoiceStatus` (still used by `send`), `publishInvoice`, `cancelInvoice`, `createDepositInvoice`, `reviseDepositInvoice`, `calculateIngredientDeposit`. Remove `getOrderPayment` from the import **only if** it becomes unused after Step 2 (the orchestrator now performs payment capture) — confirm via lint in Step 3.

- [ ] **Step 2: Replace the `sync` action body**

Replace the entire `if (action === "sync") { ... }` block (the one that calls `getInvoiceStatus`, builds `allocationUpdate`/`invoiceUpdate`, calls `getOrderPayment`, and updates `batch_allocations` + `invoices`) with:

```ts
  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    if (!allocation.square_deposit_invoice_id) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }

    const result = await reconcileInvoiceStatus(adminSupabase, allocation.square_deposit_invoice_id);

    // Re-read the allocation (server client, RLS-correct) for the response.
    const { data: updated, error: reReadErr } = await supabase
      .from("batch_allocations")
      .select("*")
      .eq("id", id)
      .single();
    if (reReadErr) return NextResponse.json({ error: reReadErr.message }, { status: 500 });

    return NextResponse.json({ allocation: updated, squareStatus: result.squareStatus });
  }
```

- [ ] **Step 3: Delete the now-unused local `mapSquareStatus`**

Remove the `function mapSquareStatus(squareStatus: string): string { ... }` helper (near the bottom of the file) — its only caller was the `sync` block just replaced. Confirm no other references:

Run: `grep -n "mapSquareStatus" app/api/production/allocations/\[id\]/invoice/route.ts`
Expected: no matches after deletion.

- [ ] **Step 4: Typecheck + lint + build**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run lint`
Expected: no unused-import/variable errors (remove `getOrderPayment` from imports if flagged).
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/allocations/[id]/invoice/route.ts
git commit -m "refactor(deposit): sync action delegates to reconcileInvoiceStatus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Daily cron invoice safety-net

**Files:**
- Modify: `app/api/cron/finance-sync/route.ts`

**Interfaces:**
- Consumes: `reconcileInvoiceStatus` (Task 5).

- [ ] **Step 1: Update imports**

In `app/api/cron/finance-sync/route.ts`, add:

```ts
import { reconcileInvoiceStatus } from "@/lib/finance/reconcileInvoiceStatus";
```

- [ ] **Step 2: Reconcile non-terminal invoices inside the cron job**

Inside the `runCronJob("finance-sync", async () => { ... })` callback, after the existing `orders`/`refunds` lines and before `return { ... }`, add:

```ts
    // Safety-net for the invoice webhook: re-reconcile every non-terminal Square
    // invoice so a missed delivery self-heals within a day. Bounded to unpaid
    // invoices; idempotent (same code path as the webhook).
    const { data: openInvoices } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("source", "square")
      .not("square_invoice_id", "is", null)
      .in("status", ["draft", "open", "partial"]);

    let invoicesReconciled = 0;
    for (const row of openInvoices ?? []) {
      try {
        await reconcileInvoiceStatus(supabase, row.square_invoice_id as string);
        invoicesReconciled++;
      } catch (e) {
        console.error("[finance-sync] invoice reconcile failed", { squareInvoiceId: row.square_invoice_id, error: e });
      }
    }
```

And extend the return value:

```ts
    return { windowDays: WINDOW_DAYS, orders, refunds, invoicesReconciled };
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run lint`
Expected: no errors in the file.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/finance-sync/route.ts
git commit -m "feat(cron): daily invoice-status safety-net via reconcileInvoiceStatus

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full test suite:** `npm run test` → all pass.
- [ ] **Coverage floor:** `npx vitest run --coverage` → `lib/` stays above the `vitest.config.ts` threshold (new tested pure code should raise it).
- [ ] **Typecheck + lint + build:** `npx tsc --noEmit && npm run lint && npm run build` → clean.
- [ ] **Grep for drift:** `grep -rn "squareStatusToLedger\|mapSquareStatus" app lib` → no matches (all three mappers consolidated into `mapSquareInvoiceStatus`).

## Ops handoff (not code — for the operator after merge/deploy)

- In the Square Developer dashboard, add the deployed webhook notification URL (matching `SQUARE_WEBHOOK_URL`) to these event subscriptions: `invoice.published`, `invoice.updated`, `invoice.payment_made`, `invoice.canceled`, `invoice.refunded`, `invoice.scheduled_charge_failed`, `invoice.deleted`.
- `SQUARE_WEBHOOK_SIGNATURE_KEY` / `SQUARE_WEBHOOK_URL` are already configured for the existing order/refund webhook — reused as-is. No new env, no migration.
- Verify end-to-end: send a test deposit invoice, mark it paid in Square, confirm the batch-log/commitments UI flips to paid and `batch_allocations.square_payment_id` is populated.
