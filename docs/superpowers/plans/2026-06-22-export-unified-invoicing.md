# Export Transactions Unified Invoicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Export tab's Distribution/Contract Brewing subtabs with a unified, customer-grouped Export Transactions view, and let the user multi-select same-customer `invoice_required` transactions to generate one combined, editable Square invoice (Packaging Fee / Excise Tax / Keg Cleaning / Forklift / Bulk Discount).

**Architecture:** Three new DB columns (no new tables — Spec 7 already built the mapping schema). A new `lib/square/export-invoices.ts` module builds multi-line Square orders/invoices with per-line discounts. Two new API routes (preview, create) compute line items server-side and hand them to a new preview modal for editing before the Square call. `ExportTab.tsx`'s two subtabs are replaced by one customer-grouped view reusing the existing `export_transactions` data.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase Postgres (admin client for writes), Square Invoices/Orders/Catalog APIs via the existing `lib/square/client.ts` wrapper, React Query for client state, Tailwind v4 for styling (matches existing `ExportTab.tsx`/`ExportSettingsPanel.tsx` conventions).

## Global Constraints

- No test runner exists in this repo. Verification is `npm run lint` + `npm run build` + manual code review + (for DB-touching tasks) a direct `curl` check against the live Supabase project using `.env.local`'s `SUPABASE_SERVICE_ROLE_KEY`. Never claim a task is verified without one of these.
- `npx supabase db push` is unreliable here — apply the new migration's SQL by pasting it into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex`, then separately run the `insert into supabase_migrations.schema_migrations (version) values (...)` tracking statement. This requires the user to paste SQL into the dashboard and confirm — the agent cannot do this step itself. **Never run `supabase migration repair --status reverted`.**
- Verify a migration was actually applied against the live schema via REST before any later task depends on it — don't assume the file in the repo means it landed.
- All new/modified write API routes use `requireRole(["brewer"])` (admin is always implicit) — consistent with the rest of Export Bay. Read routes that should be open to all authenticated roles must explicitly list every role (`["viewer","brewer","manager"]`) — `requireRole(["viewer"])` only admits viewer + admin, NOT a floor.
- `export_transactions`/`export_service_mappings`/`excise_tax_rates` writes go through `createSupabaseAdminClient()` after the role check (RLS only allows service-role writes on these tables), matching `app/api/production/export-settings/excise-tax-rates/route.ts`'s existing pattern.
- The preview/browser testing tool's working directory is locked to the main repo root — it can verify UI changes directly since this work happens on `main` in this session (no worktree was set up for this plan; confirm with the user before execution whether to use a worktree per the project's standing process, since this plan was written assuming direct main-branch execution would be confirmed at kickoff).
- Live Square invoice creation is never executed autonomously during implementation/testing — any test invoice creation against the real Square sandbox/production requires explicit, fresh user opt-in.

---

## File Structure

**New files:**
- `supabase/migrations/20260625_export_invoicing.sql` — the 3 new columns + `system_settings` seed row.
- `lib/square/export-invoices.ts` — multi-line Square order/invoice create + status fetch, for this feature only.
- `lib/finance/syncSquareInvoices.ts` — extracted from the existing sync-square route so it's callable directly (DRY: one sync implementation, two callers).
- `lib/production/exportInvoicePreview.ts` — pure-ish line-item computation logic (DB reads + math), used by the preview route.
- `app/api/production/export/invoice-preview/route.ts` — `GET`, computes line items for a set of transaction IDs.
- `app/api/production/export/invoice/route.ts` — `POST`, creates+publishes the Square invoice and updates transaction state.
- `app/api/production/export-settings/invoice-due-days/route.ts` — `GET`/`PUT` for the global `export_invoice_due_days` system setting.
- `app/production/components/ExportTransactionsTab.tsx` — the new unified, customer-grouped view (replaces the per-channel subtab rendering for distribution/contract_brewing).
- `app/production/components/InvoicePreviewModal.tsx` — the editable line-item modal.

**Modified files:**
- `app/production/components/ExportTab.tsx` — remove the Distribution/Contract Brewing tabs and `ExportsChannelTab` usage for those two channels; add the new unified tab. Taproom tab/`ExportsChannelTab` stays as-is (out of scope).
- `app/production/components/ExportSettingsPanel.tsx` — add a "Default Invoice Net Terms" field (global `export_invoice_due_days`).
- `app/production/components/PartnersTab.tsx` — add an "Export Net Terms (days)" field to the contract-partner edit form.
- `app/api/partners/contract-brewing/route.ts` and `app/api/partners/contract-brewing/[id]/route.ts` — accept/persist `export_net_terms_days`.
- `app/production/types.ts` — extend `ExportTransactionRow`-equivalent type, `ContractBrewingPartner`, add new line-item/preview types.
- `app/production/hooks/queries.ts` — new hooks for the preview/create calls and the due-days setting.
- `lib/query-keys.ts` — new keys for the above.
- `app/api/finance/ledger/sync-square/route.ts` — thin wrapper calling the extracted `syncSquareInvoicesForYear`.

---

### Task 1: Schema migration — `square_invoice_id`, `export_net_terms_days`, default net-terms setting

**Files:**
- Create: `supabase/migrations/20260625_export_invoicing.sql`

**Interfaces:**
- Produces: `export_transactions.square_invoice_id` (text, nullable), `contract_brewing_partners.export_net_terms_days` (integer, nullable), `system_settings` row `key='export_invoice_due_days'`.

- [ ] **Step 1: Write the migration file**

```sql
-- Spec 6: Export Transactions Unified Invoicing
-- Adds invoice tracking to export_transactions, per-partner net-terms
-- override, and a global net-terms default in system_settings.

alter table public.export_transactions
  add column square_invoice_id text;

alter table public.contract_brewing_partners
  add column export_net_terms_days integer;

insert into public.system_settings (key, value)
values ('export_invoice_due_days', '30'::jsonb)
on conflict (key) do nothing;
```

- [ ] **Step 2: Ask the user to apply it**

Per the project's standing process (Lesson #2 in `docs/superpowers/ROADMAP.md`), this agent cannot run `supabase db push` reliably. Ask the user to paste the SQL above into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex` and confirm it ran, then run:

```sql
insert into supabase_migrations.schema_migrations (version) values ('20260625') on conflict (version) do nothing;
```

- [ ] **Step 3: Verify against the live schema**

```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/export_transactions?select=square_invoice_id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/contract_brewing_partners?select=export_net_terms_days&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/system_settings?key=eq.export_invoice_due_days" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Expected: first two return `[{}]` or `[{"square_invoice_id":null}]`/`[{"export_net_terms_days":null}]` (column exists, no error); third returns `[{"key":"export_invoice_due_days","value":30,...}]`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260625_export_invoicing.sql
git commit -m "feat: add export invoice tracking columns + net terms default"
```

---

### Task 2: Extract `syncSquareInvoicesForYear` so it's callable outside the route

**Files:**
- Create: `lib/finance/syncSquareInvoices.ts`
- Modify: `app/api/finance/ledger/sync-square/route.ts:1-285` (replace body with a thin wrapper)

**Interfaces:**
- Produces: `syncSquareInvoicesForYear(supabase: SupabaseClient, year: number): Promise<{ year: number; synced: number; updated: number; skipped: number; total: number; errors?: string[] }>`
- Consumes: nothing new — this is a pure extraction of the existing route body (`fetchSquareInvoices`, `fetchInvoiceOrders`, `fetchCatalogItems`, `buildKegIndex`, `canOzPerUnit`, `CATEGORY_IDS`, `classifyLineItem`), no logic changes.

- [ ] **Step 1: Create `lib/finance/syncSquareInvoices.ts` with the extracted logic**

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSquareInvoices, fetchInvoiceOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";
import type { CatalogItem, Order, SquareInvoice } from "@/types/square";
import type { InvoiceStatus, InvoiceLineCategory } from "@/types/finance";

function squareStatusToLedger(status: string): InvoiceStatus {
  switch (status.toUpperCase()) {
    case "PAID":                         return "paid";
    case "DRAFT":                        return "draft";
    case "UNPAID": case "SCHEDULED":     return "open";
    case "PARTIALLY_PAID":               return "partial";
    case "CANCELED": case "REFUNDED":    return "voided";
    case "PARTIALLY_REFUNDED":            return "paid";
    default:                             return "unknown";
  }
}

function recipientName(inv: SquareInvoice): string {
  const r = inv.primary_recipient;
  if (!r) return "Unknown";
  if (r.company_name) return r.company_name;
  const parts = [r.given_name, r.family_name].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown";
}

export interface SyncSquareInvoicesResult {
  year: number;
  synced: number;
  updated: number;
  skipped: number;
  total: number;
  errors?: string[];
}

export async function syncSquareInvoicesForYear(
  supabase: SupabaseClient,
  year: number
): Promise<SyncSquareInvoicesResult> {
  // ── 1. Load partners (for customer_id → partner_id matching) ─────────────
  const { data: partners } = await supabase
    .from("contract_brewing_partners")
    .select("id, square_customer_id")
    .not("square_customer_id", "is", null);

  const partnerByCustomerId = new Map<string, string>(
    (partners ?? [])
      .filter((p): p is { id: string; square_customer_id: string } => !!p.square_customer_id)
      .map((p) => [p.square_customer_id, p.id])
  );

  // ── 2. Fetch Square invoices (all locations) then filter by year ──────────
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  const [allSquareInvoices, orders, catalogItems] = await Promise.all([
    fetchSquareInvoices(),
    fetchInvoiceOrders(startDate, endDate),
    fetchCatalogItems() as Promise<CatalogItem[]>,
  ]);

  const squareInvoices = allSquareInvoices.filter((inv) => {
    const date = (inv.created_at ?? "").slice(0, 10);
    return date >= startDate && date <= endDate;
  });

  if (squareInvoices.length === 0) {
    return { year, synced: 0, updated: 0, skipped: 0, total: 0 };
  }

  // ── 3. Build catalog indexes (for keg/can line item classification) ───────
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    if (!CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "")) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  const orderById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  // ── 4. Load variation deposit mappings (BS/PL) ───────────────────────────
  const { data: variationMappings } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id_invoice, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
    .or("bs_chart_of_accounts_id.not.is.null,pl_chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");

  const variationById = new Map<string, {
    chart_of_accounts_id_invoice: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
  }>(
    (variationMappings ?? []).map((v) => [v.square_variation_id, v])
  );

  // ── 5. Upsert each invoice ────────────────────────────────────────────────
  let synced  = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const inv of squareInvoices) {
    const order = orderById.get(inv.order_id);
    if (!order) { skipped++; continue; }

    const customerId = inv.primary_recipient?.customer_id ?? null;
    const partnerId  = customerId ? (partnerByCustomerId.get(customerId) ?? null) : null;
    const dueDate    = inv.payment_requests?.[0]?.due_date ?? null;

    const totalCents = order.total_money?.amount ?? 0;
    const taxCents   = order.total_tax_money?.amount ?? 0;
    const subtotal   = totalCents - taxCents;

    const status = squareStatusToLedger(inv.status);

    const rawData = {
      square_invoice_id: inv.id,
      square_order_id:   inv.order_id,
      square_status:     inv.status,
      created_at:        inv.created_at,
      updated_at:        inv.updated_at ?? inv.created_at,
    };

    const { data: invRow, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source:         "square",
          external_id:    inv.id,
          invoice_number: inv.invoice_number ?? inv.id,
          invoice_date:   inv.created_at.slice(0, 10),
          due_date:       dueDate,
          customer_name:  recipientName(inv),
          partner_id:     partnerId,
          status,
          subtotal_cents: subtotal,
          tax_cents:      taxCents,
          total_cents:    totalCents,
          notes:          inv.title ?? null,
          raw_data:       rawData,
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id, created_at, updated_at")
      .single();

    if (invErr || !invRow) {
      errors.push(`Invoice ${inv.invoice_number ?? inv.id}: ${invErr?.message ?? "unknown error"}`);
      continue;
    }

    const wasInserted = invRow.created_at === invRow.updated_at;
    if (wasInserted) synced++; else updated++;

    const lineItems: {
      invoice_id: string; sort_order: number; description: string;
      category: InvoiceLineCategory | null; quantity: number;
      unit_price_cents: number; total_cents: number;
      variation_name: string | null; raw_data: Record<string, string | number>;
      chart_of_accounts_id?: string | null;
      bs_chart_of_accounts_id?: string | null;
      pl_chart_of_accounts_id?: string | null;
    }[] = [];

    const carveOutAmounts = (order.discounts ?? [])
      .filter((d) => d.name.toLowerCase().includes("carve out"))
      .map((d) => d.applied_money?.amount ?? 0)
      .filter((a) => a > 0);

    (order.line_items ?? []).forEach((li, i) => {
      const qty       = parseFloat(li.quantity ?? "1");
      const gross     = li.gross_sales_money?.amount ?? 0;
      const varId     = li.catalog_object_id ?? "";
      const varName   = li.variation_name ?? "";

      let category: InvoiceLineCategory | null = null;

      const keg = kegIndex.get(varId);
      if (keg) category = "distribution_keg";

      if (!category && canVariationOz.has(varId)) category = "distribution_can";

      if (!category && li.name.toLowerCase().includes("barrel excise tax")) {
        const idx = carveOutAmounts.findIndex((a) => Math.abs(a - gross) <= 1);
        if (idx >= 0) { carveOutAmounts.splice(idx, 1); return; }
      }

      if (!category) category = classifyLineItem(li.name);

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
          uid:       li.uid,
          name:      li.name,
          var_name:  varName,
          gross:     gross,
          discount:  li.total_discount_money?.amount ?? 0,
        },
      });
    });

    if (lineItems.length) {
      const { error: liErr } = await supabase
        .from("invoice_line_items")
        .upsert(lineItems, { onConflict: "invoice_id,sort_order", ignoreDuplicates: false });
      if (liErr) errors.push(`Line items for ${inv.invoice_number ?? inv.id}: ${liErr.message}`);
      if (!liErr && lineItems.length > 0) {
        await supabase
          .from("invoice_line_items")
          .delete()
          .eq("invoice_id", invRow.id)
          .gt("sort_order", lineItems.length - 1);
      }
    }
  }

  return {
    year,
    synced,
    updated,
    skipped,
    total: squareInvoices.length,
    errors: errors.length ? errors : undefined,
  };
}
```

- [ ] **Step 2: Replace the route body with a thin wrapper**

Replace the entire contents of `app/api/finance/ledger/sync-square/route.ts` with:

```typescript
/**
 * POST /api/finance/ledger/sync-square?year=YYYY
 *
 * Fetches Square invoices for the given year and upserts them into the ledger
 * (`invoices` + `invoice_line_items`). Idempotent: re-running updates existing
 * records via the (source, external_id) unique constraint.
 *
 * Logic lives in lib/finance/syncSquareInvoices.ts so the export-invoice
 * creation flow can trigger the same sync directly without an HTTP round-trip.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const year     = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  try {
    const result = await syncSquareInvoicesForYear(supabase, year);
    return NextResponse.json(result, {
      status: result.errors?.length && result.synced + result.updated === 0 ? 500 : 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-square]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Build to confirm no regressions**

Run: `npm run build`
Expected: clean build, no type errors in either file.

- [ ] **Step 4: Manually verify the route still works**

```bash
curl -s -X POST "http://localhost:3000/api/finance/ledger/sync-square?year=2026" -H "Cookie: <your session cookie>"
```

Expected: same JSON shape as before this refactor (`{ year, synced, updated, skipped, total, errors? }`). If testing locally isn't practical, confirm via code review that the wrapper preserves identical behavior (it does — pure extraction, no logic changes).

- [ ] **Step 5: Commit**

```bash
git add lib/finance/syncSquareInvoices.ts app/api/finance/ledger/sync-square/route.ts
git commit -m "refactor: extract syncSquareInvoicesForYear for reuse outside the route"
```

---

### Task 3: `lib/production/exportInvoicePreview.ts` — line item computation

**Files:**
- Create: `lib/production/exportInvoicePreview.ts`

**Interfaces:**
- Consumes: Supabase tables `export_transactions`, `export_transaction_taxes`, `excise_tax_rates`, `export_service_mappings`, `packaging_items`, `contract_brewing_partners`.
- Produces:
  ```typescript
  export interface InvoiceLineItemDraft {
    id: string;               // client-side uid, e.g. crypto.randomUUID()
    description: string;
    quantity: number;
    unitPriceCents: number;
    squareCatalogVariationId: string | null; // null = custom amount line
    discountCatalogId?: string | null;        // set only on keg-fee lines eligible for bulk discount
  }
  export interface InvoicePreviewResult {
    customerId: string;          // contract_brewing_partners.id
    customerName: string;
    squareCustomerId: string | null;
    lineItems: InvoiceLineItemDraft[];
    dueDays: number;             // resolved partner override or global default
  }
  export async function buildInvoicePreview(
    supabase: SupabaseClient,
    transactionIds: string[]
  ): Promise<InvoicePreviewResult>
  ```
  Throws a plain `Error` with a user-facing message for: empty `transactionIds`, transactions spanning multiple customers, any transaction not in `invoice_required` status, or a missing/non-existent transaction ID — the calling route catches and maps to a 400.

- [ ] **Step 1: Write the module**

```typescript
import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildStandalonePriceMap } from "@/lib/square/catalog";
import { GALLONS_PER_BBL } from "@/lib/constants/production";

export interface InvoiceLineItemDraft {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId: string | null;
  discountCatalogId?: string | null;
}

export interface InvoicePreviewResult {
  customerId: string;
  customerName: string;
  squareCustomerId: string | null;
  lineItems: InvoiceLineItemDraft[];
  dueDays: number;
}

interface ExportTxRow {
  id: string;
  recipient_id: string | null;
  status: string;
  quantity: number;
  volume_bbl: number;
  packaging_item_id: string;
}

const DEFAULT_DUE_DAYS = 30;

export async function buildInvoicePreview(
  supabase: SupabaseClient,
  transactionIds: string[]
): Promise<InvoicePreviewResult> {
  if (transactionIds.length === 0) {
    throw new Error("At least one export transaction must be selected");
  }

  // ── 1. Load transactions + validate same-customer, invoice_required ───────
  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id")
    .in("id", transactionIds);
  if (txErr) throw new Error(txErr.message);
  if (!txs || txs.length !== transactionIds.length) {
    throw new Error("One or more export transactions were not found");
  }

  const rows = txs as ExportTxRow[];
  const customerIds = new Set(rows.map((r) => r.recipient_id));
  if (customerIds.size !== 1 || rows[0].recipient_id == null) {
    throw new Error("All selected transactions must belong to the same customer");
  }
  if (rows.some((r) => r.status !== "invoice_required")) {
    throw new Error("All selected transactions must be in Invoice Required status");
  }
  const customerId = rows[0].recipient_id as string;

  // ── 2. Load the customer (square_customer_id, net terms) ─────────────────
  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("id, company_name, square_customer_id, export_net_terms_days")
    .eq("id", customerId)
    .single();
  if (partnerErr || !partner) throw new Error("Customer not found");

  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? DEFAULT_DUE_DAYS;
  }

  // ── 3. Load packaging items (for type='keg' detection) ────────────────────
  const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];
  const { data: pkgItems } = await supabase
    .from("packaging_items")
    .select("id, type")
    .in("id", packagingItemIds);
  const pkgTypeById = new Map((pkgItems ?? []).map((p) => [p.id, p.type as string]));

  // ── 4. Load service mappings for this partner (with default fallback) ────
  const { data: mappings } = await supabase
    .from("export_service_mappings")
    .select("service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .or(`partner_id.eq.${customerId},partner_id.is.null`);

  function findMapping(serviceType: string, packagingItemId: string | null) {
    const rows2 = mappings ?? [];
    const partnerRow = rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === customerId && m.packaging_item_id === packagingItemId
    );
    if (partnerRow) return partnerRow;
    return rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === null && m.packaging_item_id === packagingItemId
    );
  }

  // ── 5. Resolve Square catalog prices for whatever variation IDs we need ──
  const catalogItems = await fetchCatalogItems();
  const priceByVariationId = buildStandalonePriceMap(catalogItems);

  const lineItems: InvoiceLineItemDraft[] = [];

  // ── 5a. Packaging Fee — one line per transaction ──────────────────────────
  const kegFeeTransactionIds = new Set<string>();
  for (const tx of rows) {
    const mapping = findMapping("packaging_fee", tx.packaging_item_id);
    if (!mapping?.square_catalog_variation_id) continue;
    const unitPriceCents = priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0;
    const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
    if (isKeg) kegFeeTransactionIds.add(tx.id);
    lineItems.push({
      id: crypto.randomUUID(),
      description: mapping.display_name,
      quantity: tx.quantity,
      unitPriceCents,
      squareCatalogVariationId: mapping.square_catalog_variation_id,
      discountCatalogId: isKeg ? findMapping("bulk_discount", null)?.square_catalog_discount_id ?? null : null,
    });
  }

  // ── 5b. Excise Tax — one line per receiving_party, rolled up ──────────────
  const { data: taxRows } = await supabase
    .from("export_transaction_taxes")
    .select("export_transaction_id, amount_usd, excise_tax_rate_id")
    .in("export_transaction_id", transactionIds);

  if (taxRows && taxRows.length > 0) {
    const rateIds = [...new Set(taxRows.map((t) => t.excise_tax_rate_id).filter((id): id is string => !!id))];
    const { data: rates } = await supabase
      .from("excise_tax_rates")
      .select("id, receiving_party, unit, square_catalog_variation_id")
      .in("id", rateIds);
    const rateById = new Map((rates ?? []).map((r) => [r.id, r]));
    const volumeByTx = new Map(rows.map((r) => [r.id, r.volume_bbl]));

    const byParty = new Map<string, { amountCents: number; units: number; unit: "bbl" | "gallon"; variationId: string | null }>();
    for (const t of taxRows) {
      const rate = t.excise_tax_rate_id ? rateById.get(t.excise_tax_rate_id) : undefined;
      const party = rate?.receiving_party ?? "Unknown";
      const volumeBbl = volumeByTx.get(t.export_transaction_id) ?? 0;
      const unit = (rate?.unit ?? "bbl") as "bbl" | "gallon";
      const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
      const entry = byParty.get(party) ?? { amountCents: 0, units: 0, unit, variationId: rate?.square_catalog_variation_id ?? null };
      entry.amountCents += Math.round(t.amount_usd * 100);
      entry.units += units;
      byParty.set(party, entry);
    }

    for (const [party, entry] of byParty) {
      lineItems.push({
        id: crypto.randomUUID(),
        description: `Excise Tax — ${party} (${entry.units.toFixed(2)} ${entry.unit}${entry.units !== 1 ? "s" : ""})`,
        quantity: 1,
        unitPriceCents: entry.amountCents,
        squareCatalogVariationId: entry.variationId,
      });
    }
  }

  // ── 5c. Keg Cleaning — one line, qty = count of keg-type fee transactions ─
  if (kegFeeTransactionIds.size > 0) {
    const mapping = findMapping("keg_cleaning", null);
    if (mapping?.square_catalog_variation_id) {
      lineItems.push({
        id: crypto.randomUUID(),
        description: mapping.display_name,
        quantity: kegFeeTransactionIds.size,
        unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
      });
    }
  }

  // ── 5d. Forklift — one flat line, regardless of transaction count ────────
  {
    const mapping = findMapping("forklift", null);
    if (mapping?.square_catalog_variation_id) {
      lineItems.push({
        id: crypto.randomUUID(),
        description: mapping.display_name,
        quantity: 1,
        unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
      });
    }
  }

  return {
    customerId,
    customerName: partner.company_name,
    squareCustomerId: partner.square_customer_id,
    lineItems,
    dueDays,
  };
}
```

- [ ] **Step 2: Build to confirm types resolve**

Run: `npm run build`
Expected: clean build. If `buildStandalonePriceMap` isn't exported from `lib/square/catalog.ts` under that exact name, fix the import — it is exported (confirmed at `lib/square/catalog.ts:57`).

- [ ] **Step 3: Commit**

```bash
git add lib/production/exportInvoicePreview.ts
git commit -m "feat: add export invoice line-item computation logic"
```

---

### Task 4: `lib/square/export-invoices.ts` — multi-line Square invoice creation

**Files:**
- Create: `lib/square/export-invoices.ts`

**Interfaces:**
- Consumes: `InvoiceLineItemDraft` from `lib/production/exportInvoicePreview.ts`; `squarePost`, `squareGet`, `squareLocationId` from `lib/square/client.ts`.
- Produces:
  ```typescript
  export interface CreateExportInvoiceParams {
    squareCustomerId: string;
    title: string;
    lineItems: InvoiceLineItemDraft[];
    dueDays: number;
  }
  export interface ExportInvoiceResult {
    orderId: string;
    invoiceId: string;
    invoiceUrl: string | null;
    squareStatus: string;
  }
  export async function createExportInvoice(params: CreateExportInvoiceParams): Promise<ExportInvoiceResult>
  export async function getExportInvoiceStatus(invoiceId: string): Promise<{ status: string; paidAt: string | null; version: number; publicUrl: string | null }>
  ```

- [ ] **Step 1: Write the module**

```typescript
/**
 * Export Transaction Invoice module.
 *
 * Builds multi-line Square orders/invoices for the combined Export
 * Transactions invoicing flow (Packaging Fee / Excise Tax / Keg Cleaning /
 * Forklift line items, with a Bulk Discount catalog discount attached to
 * keg-type Packaging Fee lines). Separate from lib/square/deposit-invoices.ts,
 * which is hardcoded to a single line item and can't represent this shape.
 */

import crypto from "crypto";
import { squarePost, squareGet, squareLocationId } from "./client";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export interface CreateExportInvoiceParams {
  squareCustomerId: string;
  title: string;
  lineItems: InvoiceLineItemDraft[];
  dueDays: number;
}

export interface ExportInvoiceResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
  squareStatus: string;
}

interface SquareOrderResponse   { order: { id: string } }
interface SquareInvoiceResponse { invoice: { id: string; status: string; public_url?: string; version?: number } }
interface SquareInvoiceGetResponse { invoice: { id: string; status: string; public_url?: string; version: number; updated_at?: string } }

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function createExportInvoice(
  params: CreateExportInvoiceParams
): Promise<ExportInvoiceResult> {
  const { squareCustomerId, title, lineItems, dueDays } = params;
  const loc = squareLocationId();

  // Discount uid is shared by every line item that references the same
  // discountCatalogId — Square scopes one discount object to N line items
  // via matching discount_uid, not by repeating the discount per line.
  const discountUidByCatalogId = new Map<string, string>();
  for (const li of lineItems) {
    if (li.discountCatalogId && !discountUidByCatalogId.has(li.discountCatalogId)) {
      discountUidByCatalogId.set(li.discountCatalogId, crypto.randomUUID());
    }
  }

  const orderLineItems = lineItems.map((li) => {
    const uid = crypto.randomUUID();
    const base: Record<string, unknown> = li.squareCatalogVariationId
      ? {
          uid,
          catalog_object_id: li.squareCatalogVariationId,
          quantity: String(li.quantity),
          base_price_money: { amount: li.unitPriceCents, currency: "USD" },
        }
      : {
          uid,
          name: li.description,
          quantity: String(li.quantity),
          item_type: "CUSTOM_AMOUNT",
          base_price_money: { amount: li.unitPriceCents, currency: "USD" },
        };
    if (li.discountCatalogId) {
      const discountUid = discountUidByCatalogId.get(li.discountCatalogId)!;
      base.applied_discounts = [{ discount_uid: discountUid }];
    }
    return base;
  });

  const orderDiscounts = [...discountUidByCatalogId.entries()].map(([catalogId, uid]) => ({
    uid,
    catalog_object_id: catalogId,
    scope: "LINE_ITEM",
  }));

  // 1. Create draft Order
  const orderResp = await squarePost<SquareOrderResponse>("/orders", {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: loc,
      customer_id: squareCustomerId,
      line_items: orderLineItems,
      ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
      state: "DRAFT",
      metadata: { source: "tpb-brewing", type: "export-invoice" },
    },
  });
  const orderId = orderResp.order.id;

  const today = new Date().toISOString().slice(0, 10);

  // 2. Create Invoice against that Order (DRAFT, not yet sent)
  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      sale_or_service_date: today,
      delivery_method: "EMAIL",
      primary_recipient: { customer_id: squareCustomerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: addDays(new Date(), dueDays),
          tipping_enabled: false,
        },
      ],
    },
  });

  // 3. Publish (send) immediately — matches the existing deposit-invoice
  // flow's two-step create-then-publish, collapsed into one call here since
  // there's no separate "review before sending" step in this feature.
  const { invoice: created } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceResp.invoice.id}`);
  await squarePost(`/invoices/${invoiceResp.invoice.id}/publish`, {
    idempotency_key: crypto.randomUUID(),
    version: created.version,
  });

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
    squareStatus: "UNPAID",
  };
}

export async function getExportInvoiceStatus(
  invoiceId: string
): Promise<{ status: string; paidAt: string | null; version: number; publicUrl: string | null }> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  const isPaid = invoice.status === "PAID";
  return {
    status: invoice.status,
    paidAt: isPaid ? (invoice.updated_at ?? new Date().toISOString()) : null,
    version: invoice.version,
    publicUrl: invoice.public_url ?? null,
  };
}
```

- [ ] **Step 2: Build to confirm types resolve**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add lib/square/export-invoices.ts
git commit -m "feat: add multi-line Square export invoice creation module"
```

---

### Task 5: `GET /api/production/export/invoice-preview` route

**Files:**
- Create: `app/api/production/export/invoice-preview/route.ts`

**Interfaces:**
- Consumes: `buildInvoicePreview` from Task 3.
- Produces: `GET ?ids=<comma-separated uuids>` → `InvoicePreviewResult` JSON, or `{ error }` with 400/500.

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildInvoicePreview } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const idsParam = req.nextUrl.searchParams.get("ids");
  const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];

  const supabase = createSupabaseAdminClient();
  try {
    const preview = await buildInvoicePreview(supabase, ids);
    return NextResponse.json(preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 2: Verify with a live curl call against a real `invoice_required` transaction**

Find a real transaction ID:

```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/export_transactions?status=eq.invoice_required&select=id,recipient_id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

If one exists, hit the route with that ID (requires a logged-in brewer session cookie locally via `npm run dev`):

```bash
curl -s "http://localhost:3000/api/production/export/invoice-preview?ids=<that-id>" -H "Cookie: <session cookie>"
```

Expected: `{ customerId, customerName, squareCustomerId, lineItems: [...], dueDays }` or a clear error message if no mappings/data exist yet. If no `invoice_required` transactions exist in the live DB, note this in the task's completion report rather than fabricating a pass — this is acceptable per the project's "no test runner" verification norms as long as the route's logic was reviewed line-by-line against Task 3's contract.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export/invoice-preview/route.ts
git commit -m "feat: add export invoice preview API route"
```

---

### Task 6: `POST /api/production/export/invoice` route

**Files:**
- Create: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `createExportInvoice` (Task 4), `syncSquareInvoicesForYear` (Task 2).
- Produces: `POST` body `{ transactionIds: string[]; lineItems: InvoiceLineItemDraft[] }` → `{ invoiceId, invoiceUrl }` JSON, 400/500 on error. Side effects: sets `square_invoice_id` + `status='unpaid'` on all `transactionIds`; fires the Finance sync (best-effort, logged not thrown).

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createExportInvoice } from "@/lib/square/export-invoices";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

interface CreateInvoiceBody {
  transactionIds: string[];
  lineItems: InvoiceLineItemDraft[];
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const body = await req.json() as CreateInvoiceBody;
  const { transactionIds, lineItems } = body;

  if (!transactionIds?.length) {
    return NextResponse.json({ error: "transactionIds is required" }, { status: 400 });
  }
  if (!lineItems?.length) {
    return NextResponse.json({ error: "At least one line item is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // ── Re-validate same-customer + invoice_required server-side ─────────────
  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status")
    .in("id", transactionIds);
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });
  if (!txs || txs.length !== transactionIds.length) {
    return NextResponse.json({ error: "One or more export transactions were not found" }, { status: 400 });
  }
  const customerIds = new Set(txs.map((t) => t.recipient_id));
  if (customerIds.size !== 1 || txs[0].recipient_id == null) {
    return NextResponse.json({ error: "All selected transactions must belong to the same customer" }, { status: 400 });
  }
  if (txs.some((t) => t.status !== "invoice_required")) {
    return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
  }
  const customerId = txs[0].recipient_id as string;

  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("company_name, square_customer_id, export_net_terms_days")
    .eq("id", customerId)
    .single();
  if (partnerErr || !partner) return NextResponse.json({ error: "Customer not found" }, { status: 400 });
  if (!partner.square_customer_id) {
    return NextResponse.json({ error: "This partner has no linked Square customer — add one in Contract Brewing Partners before invoicing" }, { status: 400 });
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

  // ── Create + publish the Square invoice ───────────────────────────────────
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

  // ── Update transaction state ───────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from("export_transactions")
    .update({ square_invoice_id: result.invoiceId, status: "unpaid" })
    .in("id", transactionIds);
  if (updateErr) {
    // The Square invoice now exists but our local state didn't update —
    // surface this loudly rather than silently losing the link.
    return NextResponse.json(
      { error: `Invoice ${result.invoiceId} was created in Square but updating local records failed: ${updateErr.message}` },
      { status: 500 }
    );
  }

  // ── Best-effort Finance ledger refresh ────────────────────────────────────
  try {
    await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
  } catch (err) {
    console.error("[export-invoice] post-create Finance sync failed:", err);
  }

  return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
}
```

- [ ] **Step 2: Build to confirm types resolve**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Code-review the route against Task 4/2's exact exported signatures**

Re-open `lib/square/export-invoices.ts` and `lib/finance/syncSquareInvoices.ts` and confirm `createExportInvoice`'s param shape and `syncSquareInvoicesForYear`'s signature match exactly what this route calls — this is the kind of signature drift the project's lessons learned explicitly call out.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "feat: add export invoice creation API route"
```

**No live Square invoice creation test in this task** — per Global Constraints, that requires explicit fresh user opt-in. Defer end-to-end Square verification to a final manual check the user runs themselves after this plan completes, or to a task explicitly opted into below (Task 10).

---

### Task 7: Global net-terms setting — API route + `ExportSettingsPanel` UI

**Files:**
- Create: `app/api/production/export-settings/invoice-due-days/route.ts`
- Modify: `app/production/components/ExportSettingsPanel.tsx:354-373` (the root export default)
- Modify: `app/production/hooks/queries.ts` (new hook)
- Modify: `lib/query-keys.ts:47-49` (new key)

**Interfaces:**
- Produces: `GET/PUT /api/production/export-settings/invoice-due-days` → `{ days: number }`.
- Produces: `useExportInvoiceDueDaysQuery()` hook returning `{ days: number }`.

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", "export_invoice_due_days")
    .single();

  if (error) return NextResponse.json({ days: 30 });
  return NextResponse.json({ days: (data.value as number) ?? 30 });
}

export async function PUT(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const { days } = await req.json() as { days: number };
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return NextResponse.json({ error: "days must be an integer between 1 and 365" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("system_settings")
    .upsert({ key: "export_invoice_due_days", value: days, updated_at: new Date().toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ days });
}
```

- [ ] **Step 2: Add the query key**

In `lib/query-keys.ts`, inside `production: { ... }`, add next to `exportSquareCatalog`:

```typescript
exportInvoiceDueDays: () => ["production", "export-invoice-due-days"] as const,
```

- [ ] **Step 3: Add the hook**

In `app/production/hooks/queries.ts`, after `useExportSquareCatalogQuery` (around line 179-186):

```typescript
export function useExportInvoiceDueDaysQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportInvoiceDueDays(),
    queryFn: () => fetchJson<{ days: number }>("/api/production/export-settings/invoice-due-days"),
  });
}
```

- [ ] **Step 4: Add the UI field**

In `app/production/components/ExportSettingsPanel.tsx`, add a new section component above `BulkDiscountSection` and render it in the default export for `scope === "full"`:

```typescript
function InvoiceTermsSection() {
  const { data } = useExportInvoiceDueDaysQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const days = data?.days ?? 30;

  async function save() {
    const value = Number(draft || days);
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    setSaving(true);
    await fetch("/api/production/export-settings/invoice-due-days", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoiceDueDays() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Default Invoice Net Terms</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Days until payment is due on a generated export invoice, used when a partner has no override set.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={365}
          value={draft !== "" ? draft : days}
          onChange={(e) => setDraft(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-20"
        />
        <span className="text-xs text-zinc-500">days</span>
        <button onClick={save} disabled={saving}
          className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
```

Add `useExportInvoiceDueDaysQuery` to the existing import from `"../hooks/queries"` at the top of the file, and add `<InvoiceTermsSection />` inside the `scope === "full"` block in the default export, after `<BulkDiscountSection />`:

```typescript
          <BulkDiscountSection />
          <InvoiceTermsSection />
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 6: Manual UI check**

Start `npm run dev`, navigate to Production > Export > Settings, confirm the new "Default Invoice Net Terms" field renders, change the value, save, reload the page, confirm the saved value persists.

- [ ] **Step 7: Commit**

```bash
git add app/api/production/export-settings/invoice-due-days/route.ts \
        app/production/components/ExportSettingsPanel.tsx \
        app/production/hooks/queries.ts lib/query-keys.ts
git commit -m "feat: add configurable default export invoice net terms"
```

---

### Task 8: Per-partner net-terms override — `PartnersTab` UI + partner API routes

**Files:**
- Modify: `app/api/partners/contract-brewing/route.ts:18-34` (POST)
- Modify: `app/api/partners/contract-brewing/[id]/route.ts:7-30` (PATCH)
- Modify: `app/production/components/PartnersTab.tsx`
- Modify: `app/production/types.ts:431-442` (`ContractBrewingPartner`)

**Interfaces:**
- Produces: `ContractBrewingPartner.export_net_terms_days: number | null` (new field on the existing type).

- [ ] **Step 1: Update the type**

In `app/production/types.ts`, inside `ContractBrewingPartner` (currently lines 431-442), add the field after `square_customer_id`:

```typescript
  square_customer_id: string | null;
  export_net_terms_days: number | null;
```

- [ ] **Step 2: Update the POST route**

In `app/api/partners/contract-brewing/route.ts`, the `POST` handler currently destructures `{ company_name, first_name, last_name, phone, address, email, notes }` and inserts those fields. Update to:

```typescript
  const body = await req.json();
  const { company_name, first_name, last_name, phone, address, email, notes, export_net_terms_days } = body;
  if (!company_name) return NextResponse.json({ error: "company_name is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .insert({
      company_name,
      first_name: first_name || null,
      last_name: last_name || null,
      phone: phone || null,
      address: address || null,
      email: email || null,
      notes: notes || null,
      export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null,
    })
    .select()
    .single();
```

- [ ] **Step 3: Update the PATCH route**

In `app/api/partners/contract-brewing/[id]/route.ts`, the `PATCH` handler currently destructures `{ company_name, first_name, last_name, phone, address, email, notes, square_customer_id }`. Update to:

```typescript
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id, export_net_terms_days } = await req.json();

  const { data, error } = await supabase
    .from("contract_brewing_partners")
    .update({
      company_name,
      first_name: first_name || null,
      last_name: last_name || null,
      phone: phone || null,
      address: address || null,
      email: email || null,
      notes: notes || null,
      ...(square_customer_id !== undefined ? { square_customer_id: square_customer_id || null } : {}),
      ...(export_net_terms_days !== undefined ? { export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null } : {}),
    })
    .eq("id", id)
    .select()
    .single();
```

- [ ] **Step 4: Add the UI field (contract partners only — suppliers don't invoice)**

In `app/production/components/PartnersTab.tsx`:

Update `PARTNER_EMPTY` (line 11-19) to include `export_net_terms_days: ""`.

Update `openEdit` (line 237-249) to also set `export_net_terms_days: kind === "contract" && "export_net_terms_days" in p ? String((p as ContractBrewingPartner).export_net_terms_days ?? "") : ""` — note `form` state is shared between contract/supplier kinds, so guard appropriately. Simpler: since `PARTNER_EMPTY` already always includes the field as `""`, just set it from `p` when present:

```typescript
  function openEdit(p: ContractBrewingPartner | Supplier) {
    setForm({
      company_name: p.company_name,
      first_name:   p.first_name  ?? "",
      last_name:    p.last_name   ?? "",
      phone:        p.phone       ?? "",
      address:      p.address     ?? "",
      email:        p.email       ?? "",
      notes:        p.notes       ?? "",
      export_net_terms_days: "export_net_terms_days" in p && p.export_net_terms_days != null ? String(p.export_net_terms_days) : "",
    });
    setEditingId(p.id);
    setShowModal(true);
  }
```

Update `handleSubmit`'s `payload` (line 256-264) to include:

```typescript
      const payload = {
        company_name: form.company_name,
        first_name:   form.first_name  || null,
        last_name:    form.last_name   || null,
        phone:        form.phone       || null,
        address:      form.address     || null,
        email:        form.email       || null,
        notes:        form.notes       || null,
        ...(kind === "contract" ? { export_net_terms_days: form.export_net_terms_days ? Number(form.export_net_terms_days) : null } : {}),
      };
```

Add the form field inside the modal (after the "Notes" `Field`, before `ModalActions`, only for contract partners):

```typescript
            {kind === "contract" && (
              <Field label="Export Net Terms (days)" hint="Leave blank to use the global default">
                <input type="number" min={1} max={365} className="inp" value={form.export_net_terms_days}
                  onChange={(e) => setForm((f) => ({ ...f, export_net_terms_days: e.target.value }))} />
              </Field>
            )}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean build. Note `PARTNER_EMPTY`'s shape is shared between contract/supplier forms — `Supplier` type doesn't have `export_net_terms_days`, so the form payload spread must stay conditional on `kind === "contract"` as written above to avoid sending the field for suppliers.

- [ ] **Step 6: Manual UI check**

In Production > Partners, edit a contract brewing partner, set "Export Net Terms (days)" to e.g. `45`, save, reopen the edit modal, confirm `45` persisted. Clear the field, save, confirm it persists as blank (null).

- [ ] **Step 7: Commit**

```bash
git add app/api/partners/contract-brewing/route.ts app/api/partners/contract-brewing/[id]/route.ts \
        app/production/components/PartnersTab.tsx app/production/types.ts
git commit -m "feat: add per-partner export invoice net terms override"
```

---

### Task 9: Unified Export Transactions view + invoice preview modal

**Files:**
- Create: `app/production/components/ExportTransactionsTab.tsx`
- Create: `app/production/components/InvoicePreviewModal.tsx`
- Modify: `app/production/components/ExportTab.tsx`
- Modify: `app/production/types.ts` (extend the export-transaction row type if needed — see Step 1)
- Modify: `app/production/hooks/queries.ts` (preview/create mutation hooks)

**Interfaces:**
- Consumes: `GET /api/production/exports` (existing), `GET /api/production/export/invoice-preview` (Task 5), `POST /api/production/export/invoice` (Task 6), `useContractPartnersQuery` (existing).
- Produces: a `ExportTransactionsTab` default export taking no props (reads its own queries), rendered for both `distribution` and `contract_brewing` channels combined.

- [ ] **Step 1: Add hooks for preview/create**

In `app/production/hooks/queries.ts`, add (near the other export-settings hooks):

```typescript
export function useInvoicePreview(transactionIds: string[]) {
  return useQuery({
    queryKey: ["production", "invoice-preview", transactionIds] as const,
    queryFn: () => fetchJson<{
      customerId: string; customerName: string; squareCustomerId: string | null;
      lineItems: { id: string; description: string; quantity: number; unitPriceCents: number; squareCatalogVariationId: string | null; discountCatalogId?: string | null }[];
      dueDays: number;
    }>(`/api/production/export/invoice-preview?ids=${transactionIds.join(",")}`),
    enabled: transactionIds.length > 0,
  });
}
```

(No mutation hook needed for the create call — `InvoicePreviewModal` calls `fetch` directly and invalidates `queryKeys.production.exports()` on success, matching the existing `remove()` pattern in `ExportTab.tsx`'s `ExportsChannelTab`.)

- [ ] **Step 2: Write `InvoicePreviewModal.tsx`**

```typescript
"use client";

import { useState } from "react";
import { Modal } from "./shared";
import { useInvoicePreview } from "../hooks/queries";

interface DraftLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId: string | null;
  discountCatalogId?: string | null;
}

export default function InvoicePreviewModal({
  transactionIds,
  onClose,
  onCreated,
}: {
  transactionIds: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { data, isLoading, error: previewError } = useInvoicePreview(transactionIds);
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const effectiveLineItems = lineItems ?? data?.lineItems ?? [];

  function updateLine(id: string, patch: Partial<DraftLineItem>) {
    setLineItems((effectiveLineItems).map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }

  function removeLine(id: string) {
    setLineItems(effectiveLineItems.filter((li) => li.id !== id));
  }

  function addLine() {
    setLineItems([
      ...effectiveLineItems,
      { id: crypto.randomUUID(), description: "", quantity: 1, unitPriceCents: 0, squareCatalogVariationId: null },
    ]);
  }

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionIds, lineItems: effectiveLineItems }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to create invoice");
      }
      onCreated();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  }

  const totalCents = effectiveLineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

  return (
    <Modal title={`Generate Invoice — ${data?.customerName ?? "…"}`} onClose={onClose} extraWide>
      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading line items…</p>
      ) : previewError ? (
        <p className="text-sm text-red-400">{previewError instanceof Error ? previewError.message : "Failed to load preview"}</p>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500">Description</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Qty</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Unit Price</th>
                  <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {effectiveLineItems.map((li) => (
                  <tr key={li.id} className="border-b border-zinc-800 last:border-0">
                    <td className="px-3 py-2">
                      <input className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-64"
                        value={li.description} onChange={(e) => updateLine(li.id, { description: e.target.value })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="1" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-16 text-right"
                        value={li.quantity} onChange={(e) => updateLine(li.id, { quantity: Number(e.target.value) })} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min={0} step="0.01" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-24 text-right"
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        onChange={(e) => updateLine(li.id, { unitPriceCents: Math.round(Number(e.target.value) * 100) })} />
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">
                      ${((li.quantity * li.unitPriceCents) / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => removeLine(li.id)} className="text-xs text-zinc-600 hover:text-red-400">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={addLine} className="text-xs px-2.5 py-1 border border-zinc-700 hover:border-zinc-500 text-zinc-300 rounded transition-colors">
            + Add line item
          </button>

          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <span className="text-sm text-zinc-400">Total</span>
            <span className="text-sm font-medium text-zinc-100 tabular-nums">${(totalCents / 100).toFixed(2)}</span>
          </div>

          {createError && <p className="text-xs text-red-400">{createError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-200" disabled={creating}>Cancel</button>
            <button onClick={handleCreate} disabled={creating || effectiveLineItems.length === 0}
              className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40">
              {creating ? "Creating…" : "Create & Send Invoice"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 3: Write `ExportTransactionsTab.tsx`**

```typescript
"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import InvoicePreviewModal from "./InvoicePreviewModal";

interface ExportTransactionRow {
  id: string;
  channel: "taproom" | "distribution" | "contract_brewing";
  recipient_id: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  square_invoice_id: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ExportTransactionsTab() {
  const { data: exports = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ExportTransactionRow[]>("/api/production/exports"),
  });
  const { data: partners = [] } = useContractPartnersQuery();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<{ customerId: string; ids: Set<string> } | null>(null);
  const [showModal, setShowModal] = useState(false);

  const partnerNameById = new Map(partners.map((p) => [p.id, p.company_name]));
  const partnerById = new Map(partners.map((p) => [p.id, p]));

  const relevant = exports.filter((e) => e.channel === "distribution" || e.channel === "contract_brewing");

  const byCustomer = new Map<string, ExportTransactionRow[]>();
  for (const tx of relevant) {
    if (!tx.recipient_id) continue;
    const list = byCustomer.get(tx.recipient_id) ?? [];
    list.push(tx);
    byCustomer.set(tx.recipient_id, list);
  }

  function toggle(customerId: string, txId: string) {
    if (!selected || selected.customerId !== customerId) {
      setSelected({ customerId, ids: new Set([txId]) });
      return;
    }
    const next = new Set(selected.ids);
    if (next.has(txId)) next.delete(txId); else next.add(txId);
    setSelected(next.size > 0 ? { customerId, ids: next } : null);
  }

  function handleInvoiceCreated() {
    setShowModal(false);
    setSelected(null);
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <div className="space-y-6">
      {[...byCustomer.entries()].map(([customerId, txs]) => {
        const partner = partnerById.get(customerId);
        const hasSquareCustomer = !!partner?.square_customer_id;
        const selectedHere = selected?.customerId === customerId ? selected.ids : new Set<string>();

        return (
          <div key={customerId} className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800">
              <h3 className="text-sm font-medium text-zinc-200">{partnerNameById.get(customerId) ?? "Unknown customer"}</h3>
              {selectedHere.size > 0 && (
                hasSquareCustomer ? (
                  <button
                    onClick={() => setShowModal(true)}
                    className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
                  >
                    Generate Invoice ({selectedHere.size})
                  </button>
                ) : (
                  <span className="text-xs text-red-400">
                    No linked Square customer — add one in Partners before invoicing
                  </span>
                )
              )}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500" />
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Date</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Batch</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Packaging</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Qty</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Status</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((tx) => (
                  <tr key={tx.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                    <td className="px-4 py-2">
                      {tx.status === "invoice_required" ? (
                        <input type="checkbox" checked={selectedHere.has(tx.id)} onChange={() => toggle(customerId, tx.id)} />
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-zinc-400 whitespace-nowrap">{fmt(tx.created_at)}</td>
                    <td className="px-4 py-2 text-zinc-200">
                      {tx.brew_batches ? `#${tx.brew_batches.batch_number} ${tx.brew_batches.beer_name}` : "—"}
                    </td>
                    <td className="px-4 py-2"><span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{tx.variant_label}</span></td>
                    <td className="px-4 py-2 text-right text-zinc-200">{tx.quantity}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        tx.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                        : tx.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                        : "bg-zinc-800 text-zinc-400"
                      }`}>
                        {tx.status === "invoice_required" ? "Invoice Required" : tx.status === "unpaid" ? "Unpaid" : "Paid"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {byCustomer.size === 0 && <p className="text-sm text-zinc-600">No distribution or contract brewing exports recorded yet.</p>}

      {showModal && selected && (
        <InvoicePreviewModal
          transactionIds={[...selected.ids]}
          onClose={() => setShowModal(false)}
          onCreated={handleInvoiceCreated}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire into `ExportTab.tsx`**

In `app/production/components/ExportTab.tsx`:

Replace the `TOP_TABS` array (lines 36-42) — remove the `distribution` and `contract_brewing` entries, add one `export_transactions` entry:

```typescript
const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "taproom", label: "Taproom" },
  { key: "export_transactions", label: "Export Transactions" },
  { key: "settings", label: "Settings" },
];
```

Update the `TopTab` type (line 34):

```typescript
type TopTab = "export_bay" | "taproom" | "export_transactions" | "settings";
```

Remove `distribution`/`contract_brewing` from `CHANNEL_TABS` (lines 44-60) — it now only needs the `taproom` entry, since `ExportsChannelTab` is only used for taproom going forward:

```typescript
const CHANNEL_TABS: { key: ExportChannel; label: string; description: string }[] = [
  {
    key: "taproom",
    label: "Taproom",
    description: "Product pushed to taproom inventory. Will sync with Square API to update item stock at the taproom location.",
  },
];
```

Update the tab-count badge logic (lines 234-238) — the count badge for `key !== "export_bay" && key !== "settings"` no longer makes sense for `export_transactions` (it spans two channels); narrow it to just `taproom`:

```typescript
            {key === "taproom" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
```

Add the import and render branch:

```typescript
import ExportTransactionsTab from "./ExportTransactionsTab";
```

```typescript
      {tab === "export_bay" && <ExportBayTab />}
      {tab === "settings" && <ExportSettingsPanel scope="full" />}
      {tab === "export_transactions" && <ExportTransactionsTab />}
      {tab === "taproom" && (
        <ExportsChannelTab
          key={tab}
          channel="taproom"
          exports={exports}
          links={links}
          recipes={recipes}
          onLinksChanged={() => {}}
        />
      )}
```

- [ ] **Step 5: Update `app/production/types.ts`/the exports API to surface `square_invoice_id`**

The existing `GET /api/production/exports` route already does `select("*", ...)`, so `square_invoice_id` (added in Task 1) comes through automatically — no route change needed. Confirm `ExportTransactionRow` in the new `ExportTransactionsTab.tsx` already includes it (it does, per Step 3 above).

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 7: Manual UI walkthrough**

Start `npm run dev`, navigate to Production > Export:
1. Confirm "Distribution" and "Contract Brewing" tabs are gone, replaced by "Export Transactions".
2. Confirm "Export Transactions" groups rows by customer, with checkboxes only on `invoice_required` rows.
3. Select one or more same-customer rows, confirm "Generate Invoice (N)" appears; selecting a row under a different customer should reset the selection to that customer only (verify by clicking a checkbox in a different customer's group after having one selected).
4. Click "Generate Invoice", confirm the preview modal opens and loads line items (or shows a clear error if no service mappings exist yet for that partner/packaging combination — expected on a fresh dataset).
5. Edit a line item's quantity/price in the modal, add a line item, remove a line item — confirm the running total updates.
6. Do **not** click "Create & Send Invoice" during this walkthrough unless the user has explicitly opted into a live Square test (see Task 10) — closing the modal via Cancel is sufficient to verify the UI.

- [ ] **Step 8: Commit**

```bash
git add app/production/components/ExportTransactionsTab.tsx app/production/components/InvoicePreviewModal.tsx \
        app/production/components/ExportTab.tsx app/production/hooks/queries.ts
git commit -m "feat: replace Distribution/Contract Brewing subtabs with unified Export Transactions invoicing view"
```

---

### Task 10 (optional, requires explicit user opt-in): Live Square invoice creation smoke test

**Files:** none — manual verification only.

- [ ] **Step 1: Ask the user for explicit, fresh opt-in**

Per Lesson #9 in `docs/superpowers/ROADMAP.md`, do not run this against real data without the user explicitly confirming in this session that a real Square invoice creation against a real partner/transaction is acceptable right now.

- [ ] **Step 2: If approved, walk through the full flow end-to-end**

Select a real `invoice_required` transaction set for one customer with a linked Square customer ID, open the preview modal, confirm line items look correct, click "Create & Send Invoice", confirm: the modal closes, the transactions' status flips to "Unpaid" in the UI, and (via the Square dashboard or `getExportInvoiceStatus`) the invoice exists and was emailed to the customer.

- [ ] **Step 3: Verify the Finance sync side effect**

Check `/api/finance/ledger/invoices` (or the Finance UI) for the new invoice appearing without needing a manual "Sync Square" click.

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), unified view + customer grouping + square_customer_id guard (Task 9), all five line-item rules including the excise rollup and bulk-discount-on-keg-lines (Task 3/4), new `export-invoices.ts` module (Task 4), API routes (Tasks 5/6), Finance sync trigger (Task 2/6), net-terms partner override + global default (Tasks 7/8) — every spec section has a task.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type consistency:** `InvoiceLineItemDraft` is defined once in Task 3 and imported (not redefined) in Tasks 4, 6, 9 — verified the shape matches across all four usages (`id`, `description`, `quantity`, `unitPriceCents`, `squareCatalogVariationId`, `discountCatalogId?`). `syncSquareInvoicesForYear`'s signature in Task 2 matches its two call sites in Task 2's route wrapper and Task 6's route.
