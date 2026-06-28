# Export UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Export tab's three-section layout (Export Bay / Taproom / Export Transactions) with a cleaner four-section layout (Export Bay / Shipments / Export Invoices), backed by a proper `invoice_id UUID FK` on `export_transactions` instead of the denormalized `square_invoice_id` varchar.

**Architecture:** DB migration adds `invoice_id → invoices(id)` FK to `export_transactions` (backfilling from the existing `square_invoice_id` join), then drops the old column. All five invoice actions in the existing route handler are updated to use the FK, and a new `invoices` list endpoint is added. The Taproom sub-tab is removed; SquareLinkManager trigger moves to ExportSettingsPanel; `ExportTransactionsTab` is replaced by two new components: `ShipmentsTab` (flat list, all channels, selection-lock for invoiceable rows) and `ExportInvoicesTab` (expandable invoice rows with draft editing).

**Tech Stack:** Next.js App Router (route handlers + "use client" components), Supabase Postgres (via `@supabase/supabase-js`), React Query (`@tanstack/react-query`), Tailwind CSS v4.

## Global Constraints

- Auth: all route handlers call `requireRole(["brewer"])` (or appropriate minimum role) via `lib/auth.ts` — never roll your own.
- Supabase client: `createSupabaseAdminClient()` in route handlers that write; `createSupabaseServerClient()` for read-only handlers.
- New API routes: `export const dynamic = "force-dynamic"` at the top.
- Business logic stays in `lib/`, not in `app/api/**` or page components.
- Schema changes: add a new migration file, never hand-edit existing ones.
- Migration filename prefix already used by spec: `20260708_export_invoice_fk.sql`.
- `invoice_type = 'standard'` is the existing check constraint value for non-deposit invoices.
- `invoices.status` must include `'draft'` after migration (generate creates a Draft; send → `'open'`; sync when paid → `'paid'`).
- No changes to `InvoicePreviewModal`, `ExportBayTab`, `app/finance/invoices/page.tsx`.
- `ExportTransactionsTab.tsx` is deleted — replaced by `ShipmentsTab.tsx`.

---

## File Map

| Action | Path |
|--------|------|
| Create | `supabase/migrations/20260708_export_invoice_fk.sql` |
| Modify | `lib/query-keys.ts` |
| Modify | `app/api/production/exports/route.ts` |
| Modify | `app/api/production/export/invoice/route.ts` |
| Create | `app/api/production/export/invoices/route.ts` |
| Create | `app/api/production/export/invoices/[id]/line-items/route.ts` |
| Modify | `app/production/components/ExportSettingsPanel.tsx` |
| Create | `app/production/components/ShipmentsTab.tsx` |
| Create | `app/production/components/ExportInvoicesTab.tsx` |
| Modify | `app/production/components/ExportTab.tsx` |
| Delete | `app/production/components/ExportTransactionsTab.tsx` |

---

## Parallel Execution Guide

Tasks within the same group may run in parallel. Each group must complete before the next begins.

| Group | Tasks | Dependency |
|-------|-------|------------|
| 1 | Task 1, Task 2, Task 7 | None |
| 2 | Task 3, Task 4, Task 5 | Task 1 applied, Task 2 done |
| 3 | Task 6, Task 8, Task 9 | Group 2 done |
| 4 | Task 10 | Group 3 done |

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/20260708_export_invoice_fk.sql`

**Interfaces:**
- Produces: `export_transactions.invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL` (replaces `square_invoice_id`)
- Produces: `invoices.status` constraint extended to include `'draft'`
- Produces: `invoice_line_items.square_catalog_variation_id text` (needed by PATCH route to recreate Square invoice from stored items)

**Context:** Read `supabase/migrations/20260627_three_channel_invoicing.sql` to see the drop-and-re-add constraint pattern used in this project.

**Background on the schema:**
- `export_transactions.square_invoice_id text` was added in `20260625_export_invoicing.sql`
- `invoices.square_invoice_id text` (distinct column, the Square API's invoice ID) was added in `20260627_invoice_square_id_separation.sql`
- `invoices.status` currently allows: `'open', 'paid', 'voided', 'partial', 'unknown'` — `'draft'` is missing
- The backfill joins `export_transactions.square_invoice_id` → `invoices.square_invoice_id` (the invoices table column), not `external_id`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260708_export_invoice_fk.sql
-- Export UI redesign: replace export_transactions.square_invoice_id with
-- a proper FK to invoices(id), add 'draft' status to invoices, and add
-- square_catalog_variation_id to invoice_line_items for draft editing.

-- 1. Add invoice_id FK column to export_transactions
ALTER TABLE public.export_transactions
  ADD COLUMN IF NOT EXISTS invoice_id uuid
  REFERENCES public.invoices(id) ON DELETE SET NULL;

-- 2. Backfill invoice_id from the invoices table via square_invoice_id match
UPDATE public.export_transactions et
SET invoice_id = inv.id
FROM public.invoices inv
WHERE et.square_invoice_id = inv.square_invoice_id
  AND inv.square_invoice_id IS NOT NULL
  AND et.invoice_id IS NULL;

-- 3. Drop the old square_invoice_id column from export_transactions
ALTER TABLE public.export_transactions
  DROP COLUMN IF EXISTS square_invoice_id;

-- 4. Extend invoices.status to include 'draft'
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'open', 'paid', 'voided', 'partial', 'unknown'));

-- 5. Add square_catalog_variation_id to invoice_line_items
--    (stored at generate time so the PATCH route can recreate the Square
--    invoice with the correct catalog items after adding/removing a line)
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS square_catalog_variation_id text;

-- 6. Index for FK lookups (export_transactions by invoice)
CREATE INDEX IF NOT EXISTS export_transactions_invoice_id_idx
  ON public.export_transactions (invoice_id);
```

- [ ] **Step 2: Apply the migration in Supabase**

```bash
# From project root — requires supabase CLI linked to the project
npx supabase db push
```

Expected: migration applied without errors. If `invoices_status_check` constraint has a different auto-generated name (Postgres uses `{table}_{col}_check` by default, but if the original was created inline the name may differ), the `DROP CONSTRAINT IF EXISTS` silently does nothing and the new constraint is added cleanly.

- [ ] **Step 3: Verify the schema change**

In Supabase Studio SQL editor (or via CLI):
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'export_transactions'
  AND column_name IN ('invoice_id', 'square_invoice_id');
-- Expected: only invoice_id appears (uuid type)

SELECT constraint_name, check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'invoices_status_check';
-- Expected: includes 'draft'

SELECT column_name FROM information_schema.columns
WHERE table_name = 'invoice_line_items'
  AND column_name = 'square_catalog_variation_id';
-- Expected: 1 row
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260708_export_invoice_fk.sql
git commit -m "feat(db): replace export_transactions.square_invoice_id with invoice_id FK"
```

---

## Task 2: Add `exportInvoices` Query Key

**Files:**
- Modify: `lib/query-keys.ts`

**Interfaces:**
- Produces: `queryKeys.production.exportInvoices()` → `["production", "export-invoices"] as const`

This is a prerequisite for both `ShipmentsTab` and `ExportInvoicesTab` (Tasks 8 and 9).

- [ ] **Step 1: Add the key**

Open `lib/query-keys.ts` and add after `exportInvoiceDueDays`:

```typescript
    exportInvoiceDueDays:  () => ["production", "export-invoice-due-days"] as const,
    depositInvoiceDueDays: () => ["production", "deposit-invoice-due-days"] as const,
    exportInvoices:        () => ["production", "export-invoices"] as const,
```

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors (or same error count as before this change).

- [ ] **Step 3: Commit**

```bash
git add lib/query-keys.ts
git commit -m "feat(query-keys): add exportInvoices key"
```

---

## Task 3: Update `exports/route.ts` — Join via `invoice_id` FK

**Files:**
- Modify: `app/api/production/exports/route.ts`

**Interfaces:**
- Consumes: `export_transactions.invoice_id` (from Task 1)
- Produces response shape (each row):
  ```typescript
  {
    id: string;
    channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
    recipient_id: string | null;
    recipient_name: string | null;
    variant_label: string;
    quantity: number;
    volume_bbl: number;
    total_excise_tax_usd: number;
    status: "invoice_required" | "unpaid" | "paid";
    invoice_id: string | null;
    invoice_number: string | null;   // from invoices table
    created_at: string;
    brew_batches: { id: string; beer_name: string; batch_number: number } | null;
  }
  ```

**Context:** The old route did a manual two-step: fetch transactions, then batch-fetch invoices by `square_invoice_id`. The new route joins directly via the `invoice_id` FK in a single Supabase query.

- [ ] **Step 1: Replace the route handler**

Replace the entire contents of `app/api/production/exports/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select(`
      id, channel, recipient_id, recipient_name, variant_label,
      quantity, volume_bbl, total_excise_tax_usd, status, invoice_id,
      created_at,
      brew_batches(id, beer_name, batch_number),
      invoices!invoice_id(invoice_number)
    `)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (txs ?? []).map((tx) => {
    const inv = tx.invoices as { invoice_number: string | null } | null;
    return {
      ...tx,
      invoice_number: inv?.invoice_number ?? null,
      invoices: undefined,
    };
  });

  return NextResponse.json(enriched);
}

// All exports must go through /api/production/export-bay/ship to enforce
// inventory depletion + allocation crediting. Direct inserts to
// export_transactions are blocked here.
export async function POST() {
  return NextResponse.json(
    { error: "Use /api/production/export-bay/ship to record exports" },
    { status: 405 }
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 3: Smoke-test in dev**

```bash
npm run dev
# In another terminal:
curl -s http://localhost:3000/api/production/exports | jq '.[0]'
```

Expected: each row has `invoice_id` (uuid or null) and `invoice_number` (string or null); no `square_invoice_id` field.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/exports/route.ts
git commit -m "feat(api): exports route — join via invoice_id FK, drop square_invoice_id"
```

---

## Task 4: Update `export/invoice/route.ts` — All Five Actions

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `invoice_id` FK on `export_transactions` (Task 1)
- Consumes: `invoices.status` includes `'draft'` (Task 1)
- Consumes: `invoice_line_items.square_catalog_variation_id` (Task 1)

**Key behavior changes per action:**

| Action | Old | New |
|--------|-----|-----|
| `generate` | sets `export_transactions.square_invoice_id` | upserts `invoices` row (draft status + line items), sets `export_transactions.invoice_id` |
| `send` | reads `txs[0].square_invoice_id` | reads `square_invoice_id` via `invoice_id` FK join; updates `invoices.status = 'open'` |
| `sync` | reads `txs[0].square_invoice_id` | same join; also updates `invoices.status = 'paid'` when Square confirms paid |
| `record` | creates `invoices` but does NOT set `invoice_id` on txns | creates `invoices`, then sets `invoice_id` on transactions |
| `mark_paid` | creates `invoices` but does NOT set `invoice_id` on txns | creates `invoices`, then sets `invoice_id` on transactions |

**Context — initial fetch:** The route currently fetches transactions with `select("id, recipient_id, recipient_name, status, square_invoice_id")`. After migration, replace `square_invoice_id` with `invoice_id`.

- [ ] **Step 1: Rewrite the route**

Replace `app/api/production/export/invoice/route.ts` in full:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createExportInvoice, publishInvoice, getInvoiceStatus } from "@/lib/square/square-invoices";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

interface PostBody {
  action: "generate" | "send" | "sync" | "mark_paid" | "record";
  transactionIds: string[];
  lineItems?: InvoiceLineItemDraft[];
  source?: string;
  external_ref?: string;
  paid_at?: string;
  total_cents?: number;
  invoice_date?: string;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  let body: PostBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action, transactionIds } = body;

  if (!["generate", "send", "sync", "mark_paid", "record"].includes(action)) {
    return NextResponse.json({ error: "action must be generate | send | sync | mark_paid | record" }, { status: 400 });
  }
  if (!transactionIds?.length) {
    return NextResponse.json({ error: "transactionIds is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, recipient_name, status, invoice_id")
    .in("id", transactionIds);
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });
  if (!txs || txs.length !== transactionIds.length) {
    return NextResponse.json({ error: "One or more export transactions were not found" }, { status: 400 });
  }
  const customerIds = new Set(txs.map((t) => t.recipient_id));
  if (customerIds.size !== 1 || txs[0].recipient_id == null) {
    return NextResponse.json({ error: "All selected transactions must belong to the same customer" }, { status: 400 });
  }
  const customerId = txs[0].recipient_id as string;

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === "generate") {
    const { lineItems } = body;
    if (!lineItems?.length) {
      return NextResponse.json({ error: "At least one line item is required" }, { status: 400 });
    }
    if (lineItems.some((li) => li.quantity <= 0 || li.unitPriceCents < 0)) {
      return NextResponse.json({ error: "Line item quantity must be positive and price cannot be negative" }, { status: 400 });
    }
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

    const { data: partner, error: partnerErr } = await supabase
      .from("contract_brewing_partners")
      .select("company_name, square_customer_id, export_net_terms_days")
      .eq("id", customerId)
      .single();
    if (partnerErr) return NextResponse.json({ error: partnerErr.message }, { status: 500 });
    if (!partner) return NextResponse.json({ error: "Customer not found" }, { status: 400 });
    if (!partner.square_customer_id) {
      return NextResponse.json({ error: "This partner has no linked Square customer — add one in Contract Brewing Partners before invoicing" }, { status: 400 });
    }

    let dueDays = partner.export_net_terms_days as number | null;
    if (dueDays == null) {
      const { data: setting, error: settingErr } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "export_invoice_due_days")
        .single();
      if (settingErr) console.error("[export-invoice] failed to fetch export_invoice_due_days setting:", settingErr);
      dueDays = (setting?.value as number) ?? 30;
    }

    let result;
    try {
      result = await createExportInvoice({
        squareCustomerId: partner.square_customer_id,
        title: `Export Invoice — ${partner.company_name}`,
        lineItems,
        dueDays,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Square invoice creation failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const totalCents = lineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

    // Upsert a Draft invoices row immediately so invoice_id can be set on txns.
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source: "square",
          external_id: result.invoiceId,
          square_invoice_id: result.invoiceId,
          invoice_number: result.invoiceNumber ?? null,
          invoice_type: "standard",
          partner_id: customerId,
          customer_name: partner.company_name,
          invoice_date: today,
          status: "draft",
          subtotal_cents: totalCents,
          tax_cents: 0,
          total_cents: totalCents,
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();
    if (invErr || !inv) {
      return NextResponse.json(
        { error: `Square invoice ${result.invoiceId} created but local invoices row failed: ${invErr?.message}` },
        { status: 500 }
      );
    }

    // Insert line items into invoice_line_items (with Square variation ID for future draft editing).
    if (lineItems.length > 0) {
      await supabase.from("invoice_line_items").insert(
        lineItems.map((li, i) => ({
          invoice_id: inv.id,
          sort_order: i,
          description: li.description,
          category: "other_services",
          quantity: li.quantity,
          unit_price_cents: li.unitPriceCents,
          total_cents: li.quantity * li.unitPriceCents,
          square_catalog_variation_id: li.squareCatalogVariationId ?? null,
        }))
      );
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ invoice_id: inv.id })
      .in("id", transactionIds);
    if (updateErr) {
      return NextResponse.json(
        { error: `Invoice created but updating transaction records failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
  }

  // ── send ──────────────────────────────────────────────────────────────────
  if (action === "send") {
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "These transactions have already been sent or paid" }, { status: 400 });
    }

    const invoiceId = txs[0].invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice has been generated yet — run generate first" }, { status: 400 });
    }
    if (txs.some((t) => t.invoice_id !== invoiceId)) {
      return NextResponse.json({ error: "Selected transactions belong to different invoices" }, { status: 400 });
    }

    // Look up the Square invoice ID via the invoices table.
    const { data: inv, error: invLookupErr } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("id", invoiceId)
      .single();
    if (invLookupErr || !inv?.square_invoice_id) {
      return NextResponse.json({ error: "Invoice record not found or missing Square ID" }, { status: 400 });
    }
    const squareInvoiceId = inv.square_invoice_id as string;

    const currentStatus = await getInvoiceStatus(squareInvoiceId);
    if (currentStatus.status === "PAID") {
      return NextResponse.json({ error: "Invoice is already paid in Square — use sync to update status" }, { status: 422 });
    }
    if (currentStatus.status === "DRAFT") {
      await publishInvoice(squareInvoiceId);
    }

    const { error: txUpdateErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .in("id", transactionIds);
    if (txUpdateErr) return NextResponse.json({ error: txUpdateErr.message }, { status: 500 });

    await supabase
      .from("invoices")
      .update({ status: "open" })
      .eq("id", invoiceId);

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-send Finance sync failed:", err);
    }

    return NextResponse.json({ ok: true });
  }

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

    const squareStatus = await getInvoiceStatus(inv.square_invoice_id as string);

    if (squareStatus.status === "PAID") {
      const { error: txUpdateErr } = await supabase
        .from("export_transactions")
        .update({ status: "paid" })
        .in("id", transactionIds)
        .eq("status", "unpaid");
      if (txUpdateErr) return NextResponse.json({ error: txUpdateErr.message }, { status: 500 });

      await supabase
        .from("invoices")
        .update({ status: "paid" })
        .eq("id", invoiceId);
    }

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-sync Finance sync failed:", err);
    }

    return NextResponse.json({ squareStatus: squareStatus.status });
  }

  // ── record ────────────────────────────────────────────────────────────────
  if (action === "record") {
    const source = body.source as string;
    if (!["quickbooks", "other"].includes(source)) {
      return NextResponse.json({ error: "source must be quickbooks or other" }, { status: 422 });
    }

    const totalCents  = body.total_cents   as number | undefined;
    const externalRef = body.external_ref  as string | undefined;
    const invoiceDate = body.invoice_date  as string | undefined;
    const lineItems   = body.lineItems     as Array<{ description: string; quantity: number; unitPriceCents: number }> | undefined;

    if (!totalCents || totalCents <= 0) return NextResponse.json({ error: "total_cents must be positive" }, { status: 400 });
    if (source === "quickbooks" && !externalRef) return NextResponse.json({ error: "external_ref (QB invoice number) is required for quickbooks source" }, { status: 400 });
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .in("id", transactionIds);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const externalId = externalRef ?? `other:${crypto.randomUUID()}`;
    const { data: inv } = await supabase
      .from("invoices")
      .upsert(
        {
          source,
          external_id:    externalId,
          invoice_number: externalRef ?? null,
          invoice_type:   "standard",
          partner_id:     customerId,
          customer_name:  txs[0].recipient_name ?? null,
          invoice_date:   (invoiceDate ?? new Date().toISOString()).slice(0, 10),
          status:         "open",
          subtotal_cents: totalCents,
          tax_cents:      0,
          total_cents:    totalCents,
          notes:          "Manually created export invoice",
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (inv?.id) {
      if (lineItems?.length) {
        await supabase.from("invoice_line_items").insert(
          lineItems.map((li, i) => ({
            invoice_id:       inv.id,
            sort_order:       i,
            description:      li.description,
            category:         "other_services",
            quantity:         li.quantity,
            unit_price_cents: li.unitPriceCents,
            total_cents:      li.quantity * li.unitPriceCents,
          }))
        );
      }
      await supabase
        .from("export_transactions")
        .update({ invoice_id: inv.id })
        .in("id", transactionIds);
    }

    return NextResponse.json({ ok: true });
  }

  // ── mark_paid ─────────────────────────────────────────────────────────────
  if (action === "mark_paid") {
    const source = body.source as string;
    if (!["quickbooks", "other"].includes(source)) {
      return NextResponse.json({ error: "source must be quickbooks or other" }, { status: 422 });
    }

    const paidAt      = body.paid_at     as string | undefined;
    const totalCents  = body.total_cents as number | undefined;
    const externalRef = body.external_ref as string | undefined;

    if (!paidAt)                                    return NextResponse.json({ error: "paid_at is required" }, { status: 400 });
    if (totalCents === undefined || totalCents < 0) return NextResponse.json({ error: "total_cents must be non-negative" }, { status: 400 });
    if (source === "quickbooks" && !externalRef)    return NextResponse.json({ error: "external_ref (QB invoice number) is required" }, { status: 400 });

    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ status: "paid" })
      .in("id", transactionIds);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const externalId = externalRef ?? `other:${crypto.randomUUID()}`;
    const { data: inv } = await supabase
      .from("invoices")
      .upsert(
        {
          source:         source === "quickbooks" ? "quickbooks" : "other",
          external_id:    externalId,
          invoice_number: externalRef ?? null,
          invoice_type:   "standard",
          partner_id:     customerId,
          customer_name:  txs[0].recipient_name ?? null,
          invoice_date:   paidAt.slice(0, 10),
          status:         "paid",
          subtotal_cents: totalCents,
          tax_cents:      0,
          total_cents:    totalCents,
          notes:          "QB backfill — export invoice",
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (inv?.id) {
      await supabase
        .from("export_transactions")
        .update({ invoice_id: inv.id })
        .in("id", transactionIds);
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
```

Note: `crypto` is a Node.js built-in available in route handlers. It was already imported in the original file via `crypto.randomUUID()` — no import needed in Next.js App Router route handlers (they run in Node.js where `crypto` is global since Node 19 / available via `import crypto from "crypto"`).

Actually — add the import at the top:
```typescript
import crypto from "crypto";
```
(Add this line after the last import.)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors. If `source` type on `invoices` complains about `'other'`, check the source column's check constraint in `20260609_invoices.sql` — it only allows `'quickbooks'` and `'square'`. If that's the case, map `source === "other"` to `"quickbooks"` with a note, or add `'other'` to the constraint in the migration.

> **Note on source constraint:** Check `supabase/migrations/20260609_invoices.sql` line ~7: `check (source in ('quickbooks', 'square'))`. The `mark_paid` action's `source = "other"` case maps to the old hardcoded `"quickbooks"` source. The plan above uses `source === "quickbooks" ? "quickbooks" : "other"` — if `'other'` is not in the constraint, change it to `"quickbooks"` (matching the old behavior) and add a TODO comment.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "feat(api): export/invoice route — use invoice_id FK, upsert draft invoices row on generate"
```

---

## Task 5: New `GET /api/production/export/invoices` Route

**Files:**
- Create: `app/api/production/export/invoices/route.ts`

**Interfaces:**
- Consumes: `invoices`, `invoice_line_items`, `export_transactions!invoice_id`, `contract_brewing_partners`
- Produces response shape (array):
  ```typescript
  interface ExportInvoiceListItem {
    id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    customer_name: string | null;
    partner_id: string | null;
    partner_name: string | null;
    status: "draft" | "open" | "paid" | "voided" | "partial" | "unknown";
    source: "square" | "quickbooks";
    square_invoice_id: string | null;
    subtotal_cents: number;
    total_cents: number;
    line_items: Array<{
      id: string;
      sort_order: number;
      description: string | null;
      category: string | null;
      quantity: number;
      unit_price_cents: number;
      total_cents: number;
      square_catalog_variation_id: string | null;
    }>;
    shipments: Array<{
      id: string;
      channel: string;
      variant_label: string;
      quantity: number;
      volume_bbl: number;
      created_at: string;
      brew_batches: { id: string; beer_name: string; batch_number: number } | null;
    }>;
  }
  ```

- [ ] **Step 1: Create the route file**

```typescript
// app/api/production/export/invoices/route.ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_number, invoice_date, customer_name, partner_id,
      status, source, square_invoice_id, subtotal_cents, total_cents,
      invoice_line_items(
        id, sort_order, description, category,
        quantity, unit_price_cents, total_cents,
        square_catalog_variation_id
      ),
      export_transactions!invoice_id(
        id, channel, variant_label, quantity, volume_bbl, created_at,
        brew_batches(id, beer_name, batch_number)
      ),
      contract_brewing_partners!partner_id(company_name)
    `)
    .not("partner_id", "is", null)
    .eq("invoice_type", "standard")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as { company_name: string } | null;
    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      customer_name: inv.customer_name,
      partner_id: inv.partner_id,
      partner_name: partner?.company_name ?? null,
      status: inv.status,
      source: inv.source,
      square_invoice_id: inv.square_invoice_id,
      subtotal_cents: inv.subtotal_cents,
      total_cents: inv.total_cents,
      line_items: (inv.invoice_line_items ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
      shipments: inv.export_transactions ?? [],
    };
  });

  return NextResponse.json(enriched);
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors. Supabase may type `export_transactions` as an array or an object depending on the FK relationship direction — if the type complains, cast with `as Array<...>`.

- [ ] **Step 3: Smoke-test**

```bash
curl -s http://localhost:3000/api/production/export/invoices | jq '.[0]'
```

Expected: invoice object with `line_items[]` and `shipments[]` arrays.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export/invoices/route.ts
git commit -m "feat(api): GET /api/production/export/invoices — invoice list with line items + shipments"
```

---

## Task 6: New `PATCH /api/production/export/invoices/[id]/line-items` Route

**Files:**
- Create: `app/api/production/export/invoices/[id]/line-items/route.ts`

**Interfaces:**
- Consumes: Task 5's invoices route (same table/shape)
- Consumes: `cancelInvoice`, `createExportInvoice` from `lib/square/square-invoices`
- Request body:
  ```typescript
  // action = "add"
  { action: "add"; description: string; quantity: number; unit_price_cents: number; square_catalog_variation_id?: string | null }
  // action = "remove"
  { action: "remove"; line_item_id: string }
  ```
- Response: `{ ok: true }` on success

**Strategy:** Rather than using Square's Update Invoice API (which requires knowing order_id and field masks), this route cancels the existing Square draft and recreates it with the updated line items. The local `invoices.id` UUID stays the same; only `invoices.square_invoice_id` changes.

**Prerequisite reading:** Read `lib/square/square-invoices.ts` — specifically `cancelInvoice` and `createExportInvoice`. `cancelInvoice` handles both DRAFT (delete) and non-DRAFT (cancel) Square invoices.

- [ ] **Step 1: Create the directory and route file**

```bash
mkdir -p app/api/production/export/invoices/\[id\]/line-items
```

```typescript
// app/api/production/export/invoices/[id]/line-items/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cancelInvoice, createExportInvoice } from "@/lib/square/square-invoices";

export const dynamic = "force-dynamic";

interface AddBody {
  action: "add";
  description: string;
  quantity: number;
  unit_price_cents: number;
  square_catalog_variation_id?: string | null;
}

interface RemoveBody {
  action: "remove";
  line_item_id: string;
}

type PatchBody = AddBody | RemoveBody;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const { id: invoiceId } = await params;

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!["add", "remove"].includes(body.action)) {
    return NextResponse.json({ error: "action must be add or remove" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Load invoice — must be draft and have a Square ID.
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, status, square_invoice_id, partner_id, customer_name, invoice_date, total_cents")
    .eq("id", invoiceId)
    .single();
  if (invErr || !inv) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (inv.status !== "draft") {
    return NextResponse.json({ error: "Line items can only be edited on Draft invoices" }, { status: 422 });
  }
  if (!inv.square_invoice_id) {
    return NextResponse.json({ error: "Invoice has no linked Square draft" }, { status: 422 });
  }

  // Load partner for Square customer ID + net terms.
  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("company_name, square_customer_id, export_net_terms_days")
    .eq("id", inv.partner_id)
    .single();
  if (partnerErr || !partner?.square_customer_id) {
    return NextResponse.json({ error: "Partner not found or missing Square customer" }, { status: 400 });
  }

  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? 30;
  }

  // Load current line items.
  const { data: currentItems, error: itemsErr } = await supabase
    .from("invoice_line_items")
    .select("id, sort_order, description, quantity, unit_price_cents, total_cents, square_catalog_variation_id")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // Build updated items list.
  type StoredItem = {
    id: string; sort_order: number; description: string | null;
    quantity: number; unit_price_cents: number; total_cents: number;
    square_catalog_variation_id: string | null;
  };

  let updatedItems: StoredItem[] = currentItems ?? [];

  if (body.action === "add") {
    const newItem: StoredItem = {
      id: crypto.randomUUID(),
      sort_order: updatedItems.length,
      description: body.description,
      quantity: body.quantity,
      unit_price_cents: body.unit_price_cents,
      total_cents: body.quantity * body.unit_price_cents,
      square_catalog_variation_id: body.square_catalog_variation_id ?? null,
    };
    updatedItems = [...updatedItems, newItem];
  } else {
    updatedItems = updatedItems.filter((item) => item.id !== body.line_item_id);
    if (updatedItems.length === (currentItems ?? []).length) {
      return NextResponse.json({ error: "Line item not found" }, { status: 404 });
    }
  }

  if (updatedItems.length === 0) {
    return NextResponse.json({ error: "Invoice must have at least one line item" }, { status: 422 });
  }

  // Cancel the existing Square draft and recreate with updated items.
  try {
    await cancelInvoice(inv.square_invoice_id as string);
  } catch (err) {
    console.error("[line-items] cancelInvoice failed:", err);
    return NextResponse.json({ error: "Failed to cancel existing Square draft" }, { status: 500 });
  }

  const lineItemsForSquare = updatedItems.map((item) => ({
    id: item.id,
    description: item.description ?? "",
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    squareCatalogVariationId: item.square_catalog_variation_id,
  }));

  let newSquareResult;
  try {
    newSquareResult = await createExportInvoice({
      squareCustomerId: partner.square_customer_id,
      title: `Export Invoice — ${partner.company_name}`,
      lineItems: lineItemsForSquare,
      dueDays,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Square invoice recreation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Update local invoice: new Square ID + new total.
  const newTotal = updatedItems.reduce((s, i) => s + i.total_cents, 0);
  const { error: invUpdateErr } = await supabase
    .from("invoices")
    .update({
      square_invoice_id: newSquareResult.invoiceId,
      external_id: newSquareResult.invoiceId,
      subtotal_cents: newTotal,
      total_cents: newTotal,
    })
    .eq("id", invoiceId);
  if (invUpdateErr) return NextResponse.json({ error: invUpdateErr.message }, { status: 500 });

  // Replace all line items in DB.
  await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
  if (updatedItems.length > 0) {
    await supabase.from("invoice_line_items").insert(
      updatedItems.map((item, i) => ({
        invoice_id: invoiceId,
        sort_order: i,
        description: item.description,
        category: "other_services",
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        total_cents: item.total_cents,
        square_catalog_variation_id: item.square_catalog_variation_id,
      }))
    );
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 3: Commit**

```bash
git add "app/api/production/export/invoices/[id]/line-items/route.ts"
git commit -m "feat(api): PATCH /export/invoices/:id/line-items — draft line item add/remove (cancel+recreate Square draft)"
```

---

## Task 7: ExportSettingsPanel — Add Square Catalog Mappings Section

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx`

**Interfaces:**
- Consumes: `SquareLinkManager` + `LinkRow` (already imported in `ExportTab.tsx`; needs adding to `ExportSettingsPanel.tsx`)
- Consumes: `useQuery` from `@tanstack/react-query`; `queryKeys.production.recipeSquareLinks()`; `useRecipesQuery`; `fetchJson`
- Produces: `ExportSettingsPanel` renders a new "Square Catalog Mappings" section with the SquareLinkManager trigger

**Context:** Read `app/production/components/ExportSettingsPanel.tsx` top-to-bottom before editing. The `SquareLinkManager` trigger was previously in `ExportTab.tsx`'s `ExportsChannelTab` function (the Taproom sub-tab). The `SquareLinkManager` component and `LinkRow` type are exported from `./SquareLinkManager`. The links data is loaded with `queryKeys.production.recipeSquareLinks()` + `fetchJson<LinkRow[]>("/api/production/recipe-square-links")`.

- [ ] **Step 1: Add imports at top of ExportSettingsPanel.tsx**

Add to the existing imports block:
```typescript
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SquareLinkManager, LinkRow } from "./SquareLinkManager";
import { useRecipesQuery, fetchJson } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
```

Check if any of these are already imported (e.g. `useState`, `useQueryClient` are already there). Deduplicate — don't double-import.

- [ ] **Step 2: Add `SquareCatalogMappingsSection` component before the `ExportSettingsPanel` default export**

```typescript
function SquareCatalogMappingsSection() {
  const qc = useQueryClient();
  const { data: links = [] } = useQuery({
    queryKey: queryKeys.production.recipeSquareLinks(),
    queryFn: () => fetchJson<LinkRow[]>("/api/production/recipe-square-links"),
  });
  const { data: recipes = [] } = useRecipesQuery();
  const [showLinks, setShowLinks] = useState(false);

  function refreshLinks() {
    qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Square Catalog Mappings</h3>
      <p className="text-xs text-zinc-600 mb-3">
        Links recipes to Square catalog items for inventory sync on taproom exports.
      </p>
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-500">
        <span>
          {links.length > 0
            ? `${links.length} Square mapping${links.length !== 1 ? "s" : ""} configured`
            : "No Square mappings yet"}
        </span>
        <button
          onClick={() => setShowLinks(true)}
          className="ml-4 shrink-0 px-2.5 py-1 border border-zinc-600 hover:border-zinc-400 text-zinc-300 rounded transition-colors"
        >
          Manage Links
        </button>
      </div>
      {showLinks && (
        <SquareLinkManager
          recipes={recipes}
          links={links}
          onClose={() => setShowLinks(false)}
          onChanged={refreshLinks}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 3: Add the section to `ExportSettingsPanel`'s render**

In the `ExportSettingsPanel` default export function, inside the `scope === "full"` block, add `<SquareCatalogMappingsSection />` at the bottom (after `<InvoiceTermsSection />`):

```typescript
export default function ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" }) {
  return (
    <div className="flex flex-col gap-8">
      <ExciseTaxRatesSection />
      {scope === "full" && (
        <>
          <section>
            <h3 className="text-sm font-medium text-zinc-200 mb-3">Service Mappings</h3>
            <div className="flex flex-col gap-6">
              <PackagingFeeSection />
              <SimpleServiceSection serviceType="keg_cleaning" />
              <SimpleServiceSection serviceType="forklift" />
            </div>
          </section>
          <BulkDiscountSection />
          <DistributionDiscountSection />
          <WholesaleDiscountSection />
          <InvoiceTermsSection />
          <SquareCatalogMappingsSection />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx
git commit -m "feat(ui): move SquareLinkManager trigger into ExportSettingsPanel"
```

---

## Task 8: New `ShipmentsTab.tsx`

**Files:**
- Create: `app/production/components/ShipmentsTab.tsx`

**Interfaces:**
- Consumes: `GET /api/production/exports` (Task 3's updated shape)
- Consumes: `queryKeys.production.exports()` from `lib/query-keys.ts`
- Consumes: `useContractPartnersQuery` from `../hooks/queries`
- Consumes: `InvoicePreviewModal` from `./InvoicePreviewModal`
- Props:
  ```typescript
  interface ShipmentsTabProps {
    onNavigateToInvoice?: (invoiceId: string) => void;
  }
  ```
- Response shape from `/api/production/exports` (one row):
  ```typescript
  interface ShipmentRow {
    id: string;
    channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
    recipient_id: string | null;
    recipient_name: string | null;
    variant_label: string;
    quantity: number;
    volume_bbl: number;
    total_excise_tax_usd: number;
    status: "invoice_required" | "unpaid" | "paid";
    invoice_id: string | null;
    invoice_number: string | null;
    created_at: string;
    brew_batches: { id: string; beer_name: string; batch_number: number } | null;
  }
  ```

**Row selection rules:**
- `channel === "taproom"` → never checkable; no Invoice # or Customer shown
- `channel !== "taproom" && status === "invoice_required"` → checkable if no selection lock, or if locked to same `recipient_id`
- `channel !== "taproom" && status !== "invoice_required"` → not checkable; shows invoice badge

**Selection lock:** First checked row sets `lockedCustomerId`. All other non-taproom `invoice_required` rows with different `recipient_id` are rendered with `disabled` checkbox + reduced opacity. Cleared when selection is emptied.

- [ ] **Step 1: Create the file**

```typescript
"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import InvoicePreviewModal from "./InvoicePreviewModal";

interface ShipmentRow {
  id: string;
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  recipient_id: string | null;
  recipient_name: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  invoice_id: string | null;
  invoice_number: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

interface ShipmentsTabProps {
  onNavigateToInvoice?: (invoiceId: string) => void;
}

type ChannelFilter = "all" | "taproom" | "distribution" | "contract_brewing" | "wholesale";
type StatusFilter = "all" | "invoice_required" | "unpaid" | "paid";

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

const CHANNEL_BADGE: Record<string, string> = {
  taproom: "bg-blue-900/40 text-blue-300",
  distribution: "bg-purple-900/40 text-purple-300",
  contract_brewing: "bg-orange-900/40 text-orange-300",
  wholesale: "bg-teal-900/40 text-teal-300",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ShipmentsTab({ onNavigateToInvoice }: ShipmentsTabProps) {
  const { data: shipments = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ShipmentRow[]>("/api/production/exports"),
  });
  const { data: partners = [] } = useContractPartnersQuery();
  const qc = useQueryClient();

  // ── Filters ────────────────────────────────────────────────────────────────
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [customerFilter, setCustomerFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<{ customerId: string; ids: Set<string> } | null>(null);
  const [showModal, setShowModal] = useState(false);

  // ── Mark Paid ──────────────────────────────────────────────────────────────
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [mpSource, setMpSource] = useState<"quickbooks" | "other">("quickbooks");
  const [mpRef, setMpRef] = useState("");
  const [mpPaidAt, setMpPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mpAmount, setMpAmount] = useState("");
  const [mpLoading, setMpLoading] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);

  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners]);
  const partnerNameById = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  const filtered = useMemo(() => {
    return shipments.filter((row) => {
      if (channelFilter !== "all" && row.channel !== channelFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (customerFilter !== "all" && row.recipient_id !== customerFilter) return false;
      if (dateFrom && row.created_at < dateFrom) return false;
      if (dateTo && row.created_at.slice(0, 10) > dateTo) return false;
      return true;
    });
  }, [shipments, channelFilter, statusFilter, customerFilter, dateFrom, dateTo]);

  const lockedCustomerId = selected?.customerId ?? null;

  function toggle(row: ShipmentRow) {
    if (row.channel === "taproom") return;
    if (row.status !== "invoice_required") return;
    const cid = row.recipient_id!;
    if (!selected || selected.customerId !== cid) {
      setSelected({ customerId: cid, ids: new Set([row.id]) });
      return;
    }
    const next = new Set(selected.ids);
    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    setSelected(next.size > 0 ? { customerId: cid, ids: next } : null);
  }

  function clearSelection() { setSelected(null); }

  function handleInvoiceCreated() {
    setShowModal(false);
    setSelected(null);
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
  }

  function openMarkPaid() {
    setMpSource("quickbooks"); setMpRef(""); setMpPaidAt(new Date().toISOString().slice(0, 10));
    setMpAmount(""); setMpError(null); setShowMarkPaid(true);
  }

  async function submitMarkPaid() {
    if (!selected) return;
    const cents = Math.round(parseFloat(mpAmount) * 100);
    setMpError(null); setMpLoading(true);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mark_paid",
          transactionIds: [...selected.ids],
          source: mpSource,
          external_ref: mpRef.trim() || undefined,
          paid_at: mpPaidAt,
          total_cents: cents,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowMarkPaid(false);
      setSelected(null);
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
      qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
    } catch (e: unknown) {
      setMpError(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally { setMpLoading(false); }
  }

  const mpAmountCents = Math.round(parseFloat(mpAmount) * 100);
  const mpValid = !!mpPaidAt && !isNaN(mpAmountCents) && mpAmountCents >= 0 &&
    (mpSource === "other" || mpRef.trim().length > 0);

  const selectedCustomerName = selected ? (partnerNameById.get(selected.customerId) ?? "Unknown") : "";
  const hasSquareCustomer = selected ? !!partnerById.get(selected.customerId)?.square_customer_id : false;

  // Unique invoiceable customers for the customer filter dropdown
  const invoiceablePartners = useMemo(() => {
    const seen = new Set<string>();
    return shipments
      .filter((r) => r.recipient_id && !seen.has(r.recipient_id) && seen.add(r.recipient_id))
      .map((r) => ({ id: r.recipient_id!, name: partnerNameById.get(r.recipient_id!) ?? r.recipient_name ?? "Unknown" }));
  }, [shipments, partnerNameById]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Channel pills */}
        <div className="flex gap-1">
          {(["all", "taproom", "distribution", "contract_brewing", "wholesale"] as ChannelFilter[]).map((ch) => (
            <button
              key={ch}
              onClick={() => setChannelFilter(ch)}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                channelFilter === ch
                  ? "border-amber-500 bg-amber-900/30 text-amber-300"
                  : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {ch === "all" ? "All" : CHANNEL_LABELS[ch]}
            </button>
          ))}
        </div>

        {/* Status */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="invoice_required">Invoice Required</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>

        {/* Customer */}
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Customers</option>
          {invoiceablePartners.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {/* Date range */}
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
        <span className="text-xs text-zinc-600">–</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-600">No shipments match the current filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 w-6" />
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Channel</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Invoice #</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const isTaproom = row.channel === "taproom";
                const isInvoiceable = !isTaproom && row.status === "invoice_required";
                const isLocked = !!lockedCustomerId && row.recipient_id !== lockedCustomerId;
                const isChecked = !!selected?.ids.has(row.id);
                const canCheck = isInvoiceable && !isLocked;

                return (
                  <tr
                    key={row.id}
                    className={`border-b border-zinc-800 last:border-0 transition-colors ${
                      isLocked ? "opacity-40" : "hover:bg-zinc-900/30"
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      {canCheck && (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(row)}
                          className="accent-amber-500"
                        />
                      )}
                      {isInvoiceable && isLocked && (
                        <input type="checkbox" disabled className="opacity-30" />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(row.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${CHANNEL_BADGE[row.channel] ?? "bg-zinc-800 text-zinc-400"}`}>
                        {CHANNEL_LABELS[row.channel] ?? row.channel}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300">
                      {isTaproom ? <span className="text-zinc-600">—</span>
                        : (partnerNameById.get(row.recipient_id!) ?? row.recipient_name ?? "Unknown")}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-200">
                      {row.brew_batches ? `#${row.brew_batches.batch_number} ${row.brew_batches.beer_name}` : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{row.variant_label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-200">{row.quantity}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        row.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                        : row.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                        : "bg-zinc-800 text-zinc-400"
                      }`}>
                        {row.status === "invoice_required" ? "Invoice Required"
                          : row.status === "unpaid" ? "Unpaid" : "Paid"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {row.invoice_id && row.invoice_number ? (
                        <button
                          onClick={() => onNavigateToInvoice?.(row.invoice_id!)}
                          className="text-xs text-amber-400 hover:text-amber-300 underline"
                        >
                          #{row.invoice_number}
                        </button>
                      ) : isTaproom ? (
                        <span className="text-zinc-600">—</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sticky action bar */}
      {selected && selected.ids.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl text-sm">
          <span className="text-zinc-400">
            {selected.ids.size} row{selected.ids.size !== 1 ? "s" : ""} selected
            {selectedCustomerName && <> — <span className="text-zinc-200">{selectedCustomerName}</span></>}
          </span>
          {!hasSquareCustomer && (
            <span className="text-xs text-zinc-500">No Square customer linked</span>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
          >
            Generate Invoice
          </button>
          <button
            onClick={openMarkPaid}
            className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors"
          >
            Mark Paid
          </button>
          <button onClick={clearSelection} className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200 transition-colors">
            Clear
          </button>
        </div>
      )}

      {/* Invoice Preview Modal */}
      {showModal && selected && (
        <InvoicePreviewModal
          transactionIds={[...selected.ids]}
          onClose={() => setShowModal(false)}
          onCreated={handleInvoiceCreated}
        />
      )}

      {/* Mark Paid Modal */}
      {showMarkPaid && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowMarkPaid(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-zinc-100">Mark as Paid (External)</h2>
            <p className="text-xs text-zinc-500">
              Record payment for {selected.ids.size} transaction{selected.ids.size !== 1 ? "s" : ""} collected outside of Square.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">Source</label>
                <select value={mpSource} onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200">
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">
                  {mpSource === "quickbooks" ? <>QB Invoice # <span className="text-red-400">*</span></> : "Reference # (optional)"}
                </label>
                <input type="text" value={mpRef} onChange={(e) => setMpRef(e.target.value)}
                  placeholder={mpSource === "quickbooks" ? "e.g. INV-1042" : "e.g. check #1234"}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Date paid <span className="text-red-400">*</span></label>
                  <input type="date" value={mpPaidAt} onChange={(e) => setMpPaidAt(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-zinc-400">Total ($) <span className="text-red-400">*</span></label>
                  <input type="number" min="0.01" step="0.01" value={mpAmount} onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600" />
                </div>
              </div>
            </div>
            {mpError && <p className="text-xs text-red-400">{mpError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowMarkPaid(false)} className="text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
              <button onClick={submitMarkPaid} disabled={mpLoading || !mpValid}
                className="text-sm px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded transition-colors disabled:opacity-40">
                {mpLoading ? "Saving…" : "Mark Paid"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 3: Commit**

```bash
git add app/production/components/ShipmentsTab.tsx
git commit -m "feat(ui): ShipmentsTab — flat list, all channels, selection-lock, sticky action bar"
```

---

## Task 9: New `ExportInvoicesTab.tsx`

**Files:**
- Create: `app/production/components/ExportInvoicesTab.tsx`

**Interfaces:**
- Consumes: `GET /api/production/export/invoices` (Task 5's shape)
- Consumes: `PATCH /api/production/export/invoices/[id]/line-items` (Task 6)
- Consumes: `POST /api/production/export/invoice` (send/sync actions, Task 4)
- Consumes: `GET /api/production/export/invoice-status` (for "View in Square" link)
- Consumes: `queryKeys.production.exportInvoices()` and `queryKeys.production.exports()`
- Consumes: `useContractPartnersQuery`, `useExportServiceMappingsQuery` from `../hooks/queries`
- Props:
  ```typescript
  interface ExportInvoicesTabProps {
    highlightInvoiceId?: string;
  }
  ```
- `ExportInvoiceListItem` type (mirrors Task 5's response shape — define locally in this file)

**Layout:** Filter bar → summary strip → expandable table. Click a row to expand/collapse its details panel.

- [ ] **Step 1: Create the file**

```typescript
"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery, useExportServiceMappingsQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { fmtUsd } from "@/lib/utils/formatting";

interface InvoiceLineItem {
  id: string;
  sort_order: number;
  description: string | null;
  category: string | null;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  square_catalog_variation_id: string | null;
}

interface InvoiceShipment {
  id: string;
  channel: string;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

interface ExportInvoiceListItem {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  customer_name: string | null;
  partner_id: string | null;
  partner_name: string | null;
  status: "draft" | "open" | "paid" | "voided" | "partial" | "unknown";
  source: "square" | "quickbooks";
  square_invoice_id: string | null;
  subtotal_cents: number;
  total_cents: number;
  line_items: InvoiceLineItem[];
  shipments: InvoiceShipment[];
}

interface ExportInvoicesTabProps {
  highlightInvoiceId?: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-zinc-800 text-zinc-400",
  open: "bg-amber-900/40 text-amber-400",
  paid: "bg-emerald-900/40 text-emerald-400",
  voided: "bg-red-900/40 text-red-400",
  partial: "bg-blue-900/40 text-blue-300",
  unknown: "bg-zinc-800 text-zinc-500",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Sent / Open",
  paid: "Paid",
  voided: "Voided",
  partial: "Partial",
  unknown: "Unknown",
};

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ViewInSquareButton({ squareInvoiceId }: { squareInvoiceId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/production/export/invoice-status?invoiceId=${squareInvoiceId}`);
      const data = await res.json();
      if (!res.ok || !data.publicUrl) { setError("Link unavailable"); return; }
      window.open(data.publicUrl, "_blank");
    } catch { setError("Failed"); }
    finally { setLoading(false); }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button onClick={open} disabled={loading}
        className="text-xs text-amber-400 hover:text-amber-300 underline disabled:opacity-50">
        {loading ? "Loading…" : "View in Square →"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

function InvoiceExpandedPanel({
  invoice,
  onRefresh,
}: {
  invoice: ExportInvoiceListItem;
  onRefresh: () => void;
}) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const [addOpen, setAddOpen] = useState(false);
  const [addDesc, setAddDesc] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [addPrice, setAddPrice] = useState("");
  const [addMappingId, setAddMappingId] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isDraft = invoice.status === "draft";
  const isSquare = invoice.source === "square";
  const isPaid = invoice.status === "paid";

  // Service mappings with a Square variation (usable as line items)
  const selectableMappings = mappings.filter(
    (m) => m.square_catalog_variation_id && m.service_type !== "bulk_discount" &&
      m.service_type !== "distribution_discount" && m.service_type !== "wholesale_discount"
  );

  async function patchLineItem(body: Record<string, unknown>) {
    setActionLoading(true); setActionError(null);
    try {
      const res = await fetch(`/api/production/export/invoices/${invoice.id}/line-items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed");
    } finally { setActionLoading(false); }
  }

  async function removeLineItem(lineItemId: string) {
    if (!confirm("Remove this line item?")) return;
    await patchLineItem({ action: "remove", line_item_id: lineItemId });
  }

  async function addLineItem() {
    if (!addDesc && !addMappingId) return;
    let description = addDesc;
    let squareCatalogVariationId: string | null = null;
    let unitPriceCents = Math.round(parseFloat(addPrice) * 100);

    if (addMappingId) {
      const mapping = selectableMappings.find((m) => m.id === addMappingId);
      if (mapping) {
        description = description || mapping.display_name;
        squareCatalogVariationId = mapping.square_catalog_variation_id;
      }
    }

    await patchLineItem({
      action: "add",
      description,
      quantity: Number(addQty) || 1,
      unit_price_cents: unitPriceCents,
      square_catalog_variation_id: squareCatalogVariationId,
    });
    setAddDesc(""); setAddQty("1"); setAddPrice(""); setAddMappingId(""); setAddOpen(false);
  }

  async function handleSend() {
    if (!confirm("Send this invoice to the customer via email?")) return;
    setActionLoading(true); setActionError(null);
    try {
      const txIds = invoice.shipments.map((s) => s.id);
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", transactionIds: txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to send");
    } finally { setActionLoading(false); }
  }

  async function handleSync() {
    setActionLoading(true); setActionError(null);
    try {
      const txIds = invoice.shipments.map((s) => s.id);
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", transactionIds: txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onRefresh();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to sync");
    } finally { setActionLoading(false); }
  }

  const panelClass = "rounded border border-zinc-800 bg-zinc-900/40 p-3 space-y-2";

  return (
    <div className="px-4 pb-4 space-y-3">
      {/* Metadata */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Invoice Details</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <span className="text-zinc-500">Customer</span>
          <span className="text-zinc-200">{invoice.partner_name ?? invoice.customer_name ?? "—"}</span>
          <span className="text-zinc-500">Issued</span>
          <span className="text-zinc-300">{invoice.invoice_date ? fmt(invoice.invoice_date) : "—"}</span>
          <span className="text-zinc-500">Status</span>
          <span className={`inline-flex items-center gap-1`}>
            <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[invoice.status]}`}>
              {STATUS_LABEL[invoice.status] ?? invoice.status}
            </span>
          </span>
          <span className="text-zinc-500">Source</span>
          <span className="text-zinc-300 capitalize">{invoice.source}</span>
          {isSquare && invoice.square_invoice_id && (
            <>
              <span className="text-zinc-500">Square ID</span>
              <ViewInSquareButton squareInvoiceId={invoice.square_invoice_id} />
            </>
          )}
        </div>
        <a
          href="/finance/invoices"
          className="text-xs text-amber-400 hover:text-amber-300 underline mt-1 inline-block"
        >
          View in Finance →
        </a>
      </div>

      {/* Included Shipments */}
      {invoice.shipments.length > 0 && (
        <div className={panelClass}>
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Included Shipments</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="pb-1">Date</th>
                <th className="pb-1">Batch</th>
                <th className="pb-1">Channel</th>
                <th className="pb-1">Packaging</th>
                <th className="pb-1 text-right">Qty</th>
                <th className="pb-1 text-right">Volume</th>
              </tr>
            </thead>
            <tbody>
              {invoice.shipments.map((s) => (
                <tr key={s.id} className="border-b border-zinc-800/50 last:border-0">
                  <td className="py-1 text-zinc-400">{fmt(s.created_at)}</td>
                  <td className="py-1 text-zinc-200">
                    {s.brew_batches ? `#${s.brew_batches.batch_number} ${s.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="py-1 text-zinc-400">{CHANNEL_LABELS[s.channel] ?? s.channel}</td>
                  <td className="py-1">
                    <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-300">{s.variant_label}</span>
                  </td>
                  <td className="py-1 text-right text-zinc-200">{s.quantity}</td>
                  <td className="py-1 text-right text-zinc-400">{s.volume_bbl.toFixed(3)} bbl</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Line Items */}
      <div className={panelClass}>
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1">Line Items</p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-800">
              <th className="pb-1">Description</th>
              <th className="pb-1 text-right">Qty</th>
              <th className="pb-1 text-right">Unit Price</th>
              <th className="pb-1 text-right">Total</th>
              {isDraft && <th className="pb-1 w-4" />}
            </tr>
          </thead>
          <tbody>
            {invoice.line_items.map((li) => (
              <tr key={li.id} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-1 text-zinc-200">{li.description ?? "—"}</td>
                <td className="py-1 text-right text-zinc-400">{li.quantity}</td>
                <td className="py-1 text-right text-zinc-400">{fmtUsd(li.unit_price_cents / 100)}</td>
                <td className="py-1 text-right text-zinc-300">{fmtUsd(li.total_cents / 100)}</td>
                {isDraft && (
                  <td className="py-1 text-right">
                    <button
                      onClick={() => removeLineItem(li.id)}
                      disabled={actionLoading}
                      className="text-zinc-600 hover:text-red-400 disabled:opacity-30"
                      title="Remove line item"
                    >
                      ×
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end pt-1 border-t border-zinc-800 mt-1">
          <span className="text-xs text-zinc-400">Total: <span className="text-zinc-100 font-medium">{fmtUsd(invoice.total_cents / 100)}</span></span>
        </div>

        {/* Add line item (Draft only) */}
        {isDraft && (
          <div className="mt-2 pt-2 border-t border-zinc-800">
            {!addOpen ? (
              <button
                onClick={() => setAddOpen(true)}
                className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
              >
                + Add line item
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select
                    value={addMappingId}
                    onChange={(e) => {
                      setAddMappingId(e.target.value);
                      if (e.target.value) setAddDesc("");
                    }}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 flex-1"
                  >
                    <option value="">Custom line item</option>
                    {selectableMappings.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Description"
                    value={addDesc}
                    onChange={(e) => setAddDesc(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 flex-1"
                  />
                  <input
                    type="number"
                    placeholder="Qty"
                    value={addQty}
                    min="1"
                    onChange={(e) => setAddQty(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-16"
                  />
                  <input
                    type="number"
                    placeholder="Unit price ($)"
                    value={addPrice}
                    min="0"
                    step="0.01"
                    onChange={(e) => setAddPrice(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-28"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={addLineItem}
                    disabled={actionLoading || (!addDesc && !addMappingId) || !addPrice}
                    className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
                  >
                    {actionLoading ? "Adding…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddOpen(false); setAddDesc(""); setAddQty("1"); setAddPrice(""); setAddMappingId(""); }}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {(isDraft || (isSquare && !isPaid)) && (
        <div className={`${panelClass} flex items-center gap-2`}>
          {isDraft && (
            <button
              onClick={handleSend}
              disabled={actionLoading}
              className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40"
            >
              {actionLoading ? "Sending…" : "Send Invoice"}
            </button>
          )}
          {isSquare && !isPaid && !isDraft && (
            <button
              onClick={handleSync}
              disabled={actionLoading}
              className="text-xs px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
            >
              {actionLoading ? "Syncing…" : "Sync from Square"}
            </button>
          )}
          {actionError && <span className="text-xs text-red-400">{actionError}</span>}
        </div>
      )}
    </div>
  );
}

export default function ExportInvoicesTab({ highlightInvoiceId }: ExportInvoicesTabProps) {
  const qc = useQueryClient();
  const { data: invoices = [] } = useQuery({
    queryKey: queryKeys.production.exportInvoices(),
    queryFn: () => fetchJson<ExportInvoiceListItem[]>("/api/production/export/invoices"),
  });
  const { data: partners = [] } = useContractPartnersQuery();

  const [expandedId, setExpandedId] = useState<string | null>(highlightInvoiceId ?? null);
  const [customerFilter, setCustomerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState<number | "all">("all");

  // Auto-expand highlighted invoice on mount
  useEffect(() => {
    if (highlightInvoiceId) setExpandedId(highlightInvoiceId);
  }, [highlightInvoiceId]);

  const partnerNames = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  const years = useMemo(() => {
    const ys = new Set(invoices.map((inv) => inv.invoice_date?.slice(0, 4)).filter(Boolean) as string[]);
    return [...ys].sort().reverse();
  }, [invoices]);

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (customerFilter !== "all" && inv.partner_id !== customerFilter) return false;
      if (statusFilter !== "all" && inv.status !== statusFilter) return false;
      if (yearFilter !== "all" && inv.invoice_date?.slice(0, 4) !== String(yearFilter)) return false;
      return true;
    });
  }, [invoices, customerFilter, statusFilter, yearFilter]);

  const openTotal = filtered
    .filter((inv) => inv.status === "open" || inv.status === "draft")
    .reduce((s, inv) => s + inv.total_cents, 0);
  const grandTotal = filtered.reduce((s, inv) => s + inv.total_cents, 0);

  function refresh() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={customerFilter}
          onChange={(e) => setCustomerFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Customers</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>{p.company_name}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Sent / Open</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
        </select>

        <select
          value={yearFilter === "all" ? "all" : String(yearFilter)}
          onChange={(e) => setYearFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200"
        >
          <option value="all">All Years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* Summary strip */}
      <div className="flex items-center gap-6 px-4 py-2 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
        <span className="text-zinc-400">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        <span className="text-zinc-500">|</span>
        <span className="text-zinc-400"><span className="text-amber-300 font-medium">{fmtUsd(openTotal / 100)}</span> open</span>
        <span className="text-zinc-500">|</span>
        <span className="text-zinc-400"><span className="text-zinc-200 font-medium">{fmtUsd(grandTotal / 100)}</span> total</span>
      </div>

      {/* Expandable table */}
      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-600">No invoices match the current filters.</p>
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 w-6" />
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Invoice #</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.id;
                return (
                  <>
                    <tr
                      key={inv.id}
                      className="border-b border-zinc-800 hover:bg-zinc-900/30 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                    >
                      <td className="px-4 py-2.5 text-zinc-500 text-xs">{isExpanded ? "▾" : "▸"}</td>
                      <td className="px-4 py-2.5 text-zinc-200 font-mono">
                        {inv.invoice_number ? `#${inv.invoice_number}` : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">
                        {inv.invoice_date ? fmt(inv.invoice_date) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-300">
                        {inv.partner_name ?? inv.customer_name ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[inv.status]}`}>
                          {STATUS_LABEL[inv.status] ?? inv.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-200 font-medium tabular-nums">
                        {fmtUsd(inv.total_cents / 100)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${inv.id}-expanded`} className="border-b border-zinc-800 bg-zinc-900/20">
                        <td colSpan={6} className="p-0">
                          <InvoiceExpandedPanel invoice={inv} onRefresh={refresh} />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

> **Note on `<>` key prop warning:** React requires keys on fragments when used in an array map. Replace `<>` with `<React.Fragment key={inv.id}>` and `<React.Fragment key={`${inv.id}-expanded`}>`. Add `import React from "react"` if needed (or use the explicit `React.Fragment` form).

- [ ] **Step 2: Fix key prop on fragments**

Replace the `<>` / `</>` wrapping the `<tr>` pair inside the map with:
```typescript
<React.Fragment key={inv.id}>
  <tr ... >...</tr>
  {isExpanded && <tr key={`${inv.id}-expanded`} ...>...</tr>}
</React.Fragment>
```

And add at top: `import React from "react";`

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 new errors.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/ExportInvoicesTab.tsx
git commit -m "feat(ui): ExportInvoicesTab — expandable invoice rows, draft line item editing, send/sync actions"
```

---

## Task 10: ExportTab Restructure + Delete Old Tab

**Files:**
- Modify: `app/production/components/ExportTab.tsx`
- Delete: `app/production/components/ExportTransactionsTab.tsx`

**Interfaces:**
- Consumes: `ShipmentsTab` from `./ShipmentsTab` (Task 8)
- Consumes: `ExportInvoicesTab` from `./ExportInvoicesTab` (Task 9)
- Removes: `ExportTransactionsTab`, `ExportsChannelTab`, Taproom sub-tab
- Removes: `SquareLinkManager`, `useRecipesQuery` (no longer used here — moved to ExportSettingsPanel)
- Removes: the `ExportChannel` type (still needed by other components? Check first)

**Dependency check before editing:** Run `grep -r "ExportChannel" app/ lib/` to see if this type is imported anywhere else. If so, move it to `types.ts` instead of deleting.

- [ ] **Step 1: Check for `ExportChannel` usage**

```bash
grep -r "ExportChannel" /path/to/project/app/ /path/to/project/lib/
```

If other files import `ExportChannel` from `ExportTab.tsx`, move the type to `app/production/types.ts` (add `export type ExportChannel = ...` there) and update imports. If no other files use it, just remove it.

- [ ] **Step 2: Rewrite `ExportTab.tsx`**

Replace the entire file:

```typescript
"use client";

import { useState } from "react";
import ExportBayTab from "./ExportBayTab";
import ShipmentsTab from "./ShipmentsTab";
import ExportInvoicesTab from "./ExportInvoicesTab";

type TopTab = "export_bay" | "shipments" | "export_invoices";

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "shipments", label: "Shipments" },
  { key: "export_invoices", label: "Export Invoices" },
];

export default function ExportTab() {
  const [tab, setTab] = useState<TopTab>("export_bay");
  const [highlightInvoiceId, setHighlightInvoiceId] = useState<string | undefined>();

  function navigateToInvoice(invoiceId: string) {
    setHighlightInvoiceId(invoiceId);
    setTab("export_invoices");
  }

  return (
    <>
      {/* Header */}
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Commitments and fulfillment — track what has been allocated and what has shipped.</p>
      </div>

      {/* Top tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
        {TOP_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setTab(key); if (key !== "export_invoices") setHighlightInvoiceId(undefined); }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "export_bay" && <ExportBayTab />}
      {tab === "shipments" && <ShipmentsTab onNavigateToInvoice={navigateToInvoice} />}
      {tab === "export_invoices" && <ExportInvoicesTab highlightInvoiceId={highlightInvoiceId} />}
    </>
  );
}
```

- [ ] **Step 3: Delete `ExportTransactionsTab.tsx`**

```bash
git rm app/production/components/ExportTransactionsTab.tsx
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors. If `ExportChannel` or `ExportTransactionRow` is imported elsewhere, fix those imports first.

- [ ] **Step 5: Build check**

```bash
npm run build
```

Expected: clean build with no errors.

- [ ] **Step 6: Dev server smoke-test**

```bash
npm run dev
```

Navigate to Production → Export. Verify:
- Three tabs visible: Export Bay, Shipments, Export Invoices
- No "Taproom" tab
- Shipments tab shows all channels (taproom rows have no checkbox, no customer, no invoice #)
- Clicking an invoice number badge on Shipments tab switches to Export Invoices and expands that invoice
- Export Invoices tab shows expandable rows; Draft invoices show Send button and line item editing
- Export Settings panel (gear icon) shows "Square Catalog Mappings" section with "Manage Links" button

- [ ] **Step 7: Commit**

```bash
git add app/production/components/ExportTab.tsx
git commit -m "feat(ui): ExportTab — Shipments + Export Invoices tabs, remove Taproom sub-tab"
```

---

## Self-Review Checklist

### Spec coverage

| Spec requirement | Covered by |
|-----------------|-----------|
| Tab structure: Export Bay / Shipments / Export Invoices | Task 10 |
| Remove Taproom tab | Task 10 |
| SquareLinkManager moves to ExportSettingsPanel | Task 7 |
| `export_transactions.invoice_id UUID FK` | Task 1 |
| Backfill via square_invoice_id | Task 1 |
| Drop export_transactions.square_invoice_id | Task 1 |
| exports route join via invoice_id | Task 3 |
| generate: upsert draft invoices row immediately | Task 4 |
| send: lookup Square ID via invoice_id FK | Task 4 |
| send: update invoices.status = 'open' | Task 4 |
| sync: update invoices.status = 'paid' | Task 4 |
| record: set invoice_id on transactions | Task 4 |
| mark_paid: set invoice_id on transactions | Task 4 |
| New GET /api/production/export/invoices | Task 5 |
| New PATCH /export/invoices/[id]/line-items | Task 6 |
| ShipmentsTab: flat list, all channels | Task 8 |
| ShipmentsTab: channel badges | Task 8 |
| ShipmentsTab: filter bar (channel/status/customer/date) | Task 8 |
| ShipmentsTab: selection-lock by customer | Task 8 |
| ShipmentsTab: sticky action bar (generate/mark paid/clear) | Task 8 |
| ShipmentsTab: invoice # badge → navigates to Export Invoices | Task 8+10 |
| ExportInvoicesTab: filter bar | Task 9 |
| ExportInvoicesTab: summary strip | Task 9 |
| ExportInvoicesTab: expandable rows | Task 9 |
| ExportInvoicesTab: metadata panel (customer, date, status, Square ID link, View in Finance) | Task 9 |
| ExportInvoicesTab: included shipments panel | Task 9 |
| ExportInvoicesTab: line items panel with totals | Task 9 |
| ExportInvoicesTab: draft line item add/remove | Task 9 |
| ExportInvoicesTab: Send Invoice button (Draft only) | Task 9 |
| ExportInvoicesTab: Sync from Square button (Square non-paid) | Task 9 |
| invoices.status includes 'draft' | Task 1 |
| invoice_line_items.square_catalog_variation_id | Task 1 |

### Known edge cases to test manually

1. **First export generate flow** — check that after `generate`, the transaction's `invoice_id` is set and the invoice row appears in Export Invoices tab with status "Draft".
2. **Send flow** — after Send, transaction status → "unpaid", invoice status → "open"; Send button disappears; Sync button appears.
3. **Invoice number badge in Shipments** — clicking switches to Export Invoices and expands the correct row.
4. **Line item remove on Draft** — removes item; Square draft is cancelled and recreated with remaining items.
5. **Migration backfill** — existing transactions with a `square_invoice_id` should have `invoice_id` populated post-migration.
