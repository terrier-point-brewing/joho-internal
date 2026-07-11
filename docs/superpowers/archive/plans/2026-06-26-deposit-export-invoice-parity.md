# Deposit/Export Invoice Parity + Strict Packaging-Preference Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the deposit-invoice flow to parity with the export-invoice flow (shared Square module, shared mapping table, generate/send/sync symmetry, closing the export-never-reaches-paid gap), fix the `ExportSettingsPanel.tsx` bug bundle, and rekey `commitment_packaging_preferences` to the strict `packaging_variations` model established by Specs 9-11.

**Architecture:** One generic Square order+invoice creator in a new `lib/square/square-invoices.ts` (replacing `deposit-invoices.ts` + `export-invoices.ts`) backs both invoice flows via thin domain wrappers. `export_service_mappings` renames to `invoice_item_mappings` and gains an `ingredient_deposit` service type. Both invoice API routes converge on the same `generate | send | sync` action shape. `commitment_packaging_preferences` is rekeyed from `packaging_item_id` to `variation_id`, with `CommitmentsTab.tsx` switched from a free-pick packaging selector to a recipe-scoped declared-variation picker, mirroring `TransferModal.tsx`'s existing pattern.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Square API (raw `fetch`), Tailwind v4, React Query.

## Global Constraints

- No test runner exists in this repo — verification is `npm run lint` (must show 0 errors/warnings) + `npm run build` + direct code review + a REST check against the live Supabase project (`drlsazatrcrdwaihjmex`) for each migration. `npm run build` alone does NOT run ESLint under Turbopack — **every task below must explicitly run `npm run lint` as its own step, not rely on `npm run build`.**
- Migrations are never applied via `npx supabase db push` (unreliable in this repo) — paste SQL directly into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex`, then run the `insert into supabase_migrations.schema_migrations (version) values (...) on conflict (version) do nothing;` tracking insert. This requires the user to paste SQL themselves and confirm back — the agent cannot do this step itself.
- `requireRole([...])` is a literal allow-list, not a floor — a route meant to be readable by all authenticated roles must spell out every role explicitly (e.g. `["viewer","brewer","manager"]`), never assume `["viewer"]` covers more than viewer+admin.
- Every implementer and reviewer dispatch for this plan must be told explicitly, in the dispatch instructions: run `npm run lint` and confirm 0 errors/warnings, in addition to `npm run build`.

---

## Task 1: Schema — `invoice_item_mappings` + deposit settings columns

**Files:**
- Create: `supabase/migrations/20260629_invoice_item_mappings.sql`

**Interfaces:**
- Produces: table `public.invoice_item_mappings` (renamed from `export_service_mappings`, same columns plus `service_type` check now including `'ingredient_deposit'`), column `public.contract_brewing_partners.deposit_net_terms_days` (nullable int), `system_settings` row `key = 'deposit_invoice_due_days'`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260629_invoice_item_mappings.sql
-- Spec 8: rename export_service_mappings -> invoice_item_mappings (no longer
-- export-specific once it covers deposits too), add the ingredient_deposit
-- service type, and add deposit-specific due-date settings.

alter table public.export_service_mappings rename to invoice_item_mappings;

alter index export_service_mappings_lookup_idx
  rename to invoice_item_mappings_lookup_idx;

alter table public.invoice_item_mappings
  drop constraint export_service_mappings_service_type_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_service_type_check
  check (service_type in ('packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount', 'ingredient_deposit'));

alter table public.invoice_item_mappings
  drop constraint export_service_mappings_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_check
  check (
    (service_type = 'packaging_fee' and packaging_item_id is not null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type in ('keg_cleaning', 'forklift') and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type = 'bulk_discount' and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null)
    or
    (service_type = 'ingredient_deposit' and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
  );

alter table public.contract_brewing_partners
  add column deposit_net_terms_days integer;

insert into public.system_settings (key, value)
values ('deposit_invoice_due_days', '30'::jsonb)
on conflict (key) do nothing;
```

- [ ] **Step 2: Apply the migration to the live database**

Tell the user: "This migration renames a live table (`export_service_mappings` → `invoice_item_mappings`) and changes its check constraints. Please paste the SQL above into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex` and run it, then confirm back here." Wait for confirmation before proceeding.

- [ ] **Step 3: Record the migration in CLI tracking**

Ask the user to also run in the same SQL Editor:

```sql
insert into supabase_migrations.schema_migrations (version) values ('20260629') on conflict (version) do nothing;
```

- [ ] **Step 4: Verify via REST**

```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/invoice_item_mappings?select=*&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `200` with `[]` or existing rows (not a 404/relation-not-found error). Also confirm the old name is gone:
```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/export_service_mappings?select=*&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: error response (relation does not exist).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260629_invoice_item_mappings.sql
git commit -m "feat: rename export_service_mappings to invoice_item_mappings, add ingredient_deposit + deposit due-date settings"
```

---

## Task 2: Schema — `commitment_packaging_preferences` strict rekey

**Files:**
- Create: `supabase/migrations/20260630_commitment_packaging_strict.sql`

**Interfaces:**
- Produces: `commitment_packaging_preferences.variation_id` (replaces `packaging_item_id`), FK to `packaging_variations(id)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260630_commitment_packaging_strict.sql
-- Spec 8: commitment_packaging_preferences moves from free-pick
-- packaging_item_id to strict variation_id, matching the
-- recipe_packaging_variations-declared-set principle Spec 10 established
-- for batch_transfers/cold_storage_inventory. No backfill — this table has
-- no cost-calc consumer today and live data is low-stakes (same precedent
-- Spec 10 set).

alter table public.commitment_packaging_preferences
  drop column packaging_item_id,
  add column variation_id uuid references public.packaging_variations(id) on delete restrict;

alter table public.commitment_packaging_preferences
  alter column variation_id set not null;
```

- [ ] **Step 2: Apply to the live database**

Tell the user: "This migration drops `commitment_packaging_preferences.packaging_item_id` (no backfill, per the confirmed low-stakes-data decision) and adds a required `variation_id`. Please paste the SQL above into the Supabase Dashboard SQL Editor for `drlsazatrcrdwaihjmex` and run it, then confirm." Wait for confirmation.

- [ ] **Step 3: Record in CLI tracking**

```sql
insert into supabase_migrations.schema_migrations (version) values ('20260630') on conflict (version) do nothing;
```

- [ ] **Step 4: Verify via REST**

```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/commitment_packaging_preferences?select=id,variation_id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `200`, no `packaging_item_id` field present, `variation_id` field present.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260630_commitment_packaging_strict.sql
git commit -m "feat: rekey commitment_packaging_preferences to variation_id"
```

---

## Task 3: Merge `deposit-invoices.ts` + `export-invoices.ts` into `lib/square/square-invoices.ts`

**Files:**
- Create: `lib/square/square-invoices.ts`
- Delete: `lib/square/deposit-invoices.ts`, `lib/square/export-invoices.ts`
- Modify (import path only, no logic change in this task): `app/api/production/allocations/[id]/invoice/route.ts`, `app/api/production/export/invoice/route.ts`, `app/api/production/export/invoice-status/route.ts`, `app/production/components/BatchLogTab.tsx`, `app/production/components/DepositInvoiceModal.tsx`

**Interfaces:**
- Produces: `calculateIngredientDeposit(supabase, batchId, percentage): Promise<DepositCalculation>` (unchanged signature), `createDepositInvoice(params: CreateDepositInvoiceParams): Promise<DepositInvoiceResult>`, `createExportInvoice(params: CreateExportInvoiceParams): Promise<ExportInvoiceResult>`, `publishInvoice(invoiceId: string): Promise<void>`, `getInvoiceStatus(invoiceId: string): Promise<{status, paidAt, version, publicUrl}>`, `cancelInvoice(invoiceId: string): Promise<void>`, `reviseDepositInvoice(oldInvoiceId, newParams): Promise<DepositInvoiceResult>`, `getOrderPayment(orderId): Promise<{paymentId, amountPaidCents}>`.
- Consumes: `squarePost`/`squareGet`/`squareLocationId` from `./client`, `InvoiceLineItemDraft` from `@/lib/production/exportInvoicePreview`.

- [ ] **Step 1: Write the merged module**

```ts
// lib/square/square-invoices.ts
/**
 * Square Invoice module — shared by the deposit-invoice flow (batch
 * allocations) and the export-transaction invoice flow. A single generic
 * order+invoice creator (`createInvoice`) backs both; `createDepositInvoice`
 * and `createExportInvoice` are thin, domain-named wrappers so existing
 * call sites keep their original parameter shapes.
 */

import crypto from "crypto";
import { squarePost, squareGet, squareLocationId } from "./client";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DepositCalculation {
  total_ingredient_cost_usd: number;
  deposit_usd: number;
  deposit_cents: number;
  ingredient_count: number;
  breakdown: Array<{
    name: string;
    quantity_per_bbl: number;
    cost_per_unit: number;
    unit: string;
    line_total_usd: number;
  }>;
}

export interface CreateDepositInvoiceParams {
  squareCustomerId: string;
  title: string;
  description: string;
  depositCents: number;
  serviceDate: string;
  dueDate: string;
  depositVariationId?: string | null;
}

export interface DepositInvoiceResult {
  orderId: string;
  invoiceId: string;
  invoiceUrl: string | null;
  squareStatus: string;
}

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
interface SquareOrderTender {
  id: string;
  payment_id?: string;
  amount_money?: { amount: number; currency: string };
}
interface SquareOrderGetResponse {
  order: { id: string; tenders?: SquareOrderTender[] };
}

function addDays(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Deposit calculation (pure math, no Square calls) ───────────────────────────

/**
 * Computes the ingredient deposit amount for a given allocation.
 * Formula: sum(ri.quantity_per_bbl × i.cost_per_unit) × batch.volume_bbl × (percentage / 100)
 */
export async function calculateIngredientDeposit(
  supabase: SupabaseClient,
  batchId: string,
  percentage: number
): Promise<DepositCalculation> {
  const { data: batch, error: batchErr } = await supabase
    .from("brew_batches")
    .select("id, beer_name, volume_bbl, turns, recipe_id")
    .eq("id", batchId)
    .single();

  if (batchErr || !batch) throw new Error("Batch not found");
  if (!batch.recipe_id) throw new Error("Batch has no recipe — cannot compute ingredient deposit");

  const { data: recipeIngredients, error: riErr } = await supabase
    .from("recipe_ingredients")
    .select("quantity_per_bbl, ingredients(id, name, unit, cost_per_unit)")
    .eq("recipe_id", batch.recipe_id);

  if (riErr) throw new Error(`Failed to fetch recipe ingredients: ${riErr.message}`);

  const rows = recipeIngredients ?? [];
  const volumeBbl = Number(batch.volume_bbl);

  let totalIngredientCostUsd = 0;
  const breakdown: DepositCalculation["breakdown"] = [];

  for (const ri of rows) {
    const ing = ri.ingredients as unknown as { id: string; name: string; unit: string; cost_per_unit: number | null } | null;
    if (!ing || ing.cost_per_unit == null) continue;

    const qtyPerBbl = Number(ri.quantity_per_bbl);
    const costPerUnit = Number(ing.cost_per_unit);
    const lineTotal = qtyPerBbl * costPerUnit * volumeBbl;

    totalIngredientCostUsd += lineTotal;
    breakdown.push({
      name: ing.name,
      quantity_per_bbl: qtyPerBbl,
      cost_per_unit: costPerUnit,
      unit: ing.unit,
      line_total_usd: lineTotal,
    });
  }

  const depositUsd = totalIngredientCostUsd * (percentage / 100);
  const depositCents = Math.round(depositUsd * 100);

  return {
    total_ingredient_cost_usd: totalIngredientCostUsd,
    deposit_usd: depositUsd,
    deposit_cents: depositCents,
    ingredient_count: breakdown.length,
    breakdown,
  };
}

// ── Generic order+invoice creator ───────────────────────────────────────────────

interface CreateInvoiceCoreParams {
  squareCustomerId: string;
  title: string;
  description?: string;
  lineItems: InvoiceLineItemDraft[];
  /** Exactly one of dueDays or dueDate must be provided. */
  dueDays?: number;
  dueDate?: string;
  /** Defaults to today (YYYY-MM-DD) if omitted. */
  serviceDate?: string;
  acceptedPaymentMethods?: { card: boolean; bank_account: boolean; cash_app_pay: boolean; buy_now_pay_later: boolean };
  metadataType: "allocation-deposit" | "export-invoice";
}

/**
 * Creates a draft Square Order + Invoice (DRAFT status, never published —
 * publishing is always a separate, explicit `send` action in both flows).
 */
async function createInvoice(params: CreateInvoiceCoreParams): Promise<{ orderId: string; invoiceId: string; invoiceUrl: string | null; squareStatus: string }> {
  const { squareCustomerId, title, description, lineItems, dueDays, dueDate, serviceDate, acceptedPaymentMethods, metadataType } = params;
  const loc = squareLocationId();

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

  const orderResp = await squarePost<SquareOrderResponse>("/orders", {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: loc,
      customer_id: squareCustomerId,
      line_items: orderLineItems,
      ...(orderDiscounts.length > 0 ? { discounts: orderDiscounts } : {}),
      state: "DRAFT",
      metadata: { source: "tpb-brewing", type: metadataType },
    },
  });
  const orderId = orderResp.order.id;

  const today = new Date().toISOString().slice(0, 10);
  if (dueDays == null && dueDate == null) throw new Error("createInvoice requires either dueDays or dueDate");

  const invoiceResp = await squarePost<SquareInvoiceResponse>("/invoices", {
    idempotency_key: crypto.randomUUID(),
    invoice: {
      location_id: loc,
      order_id: orderId,
      title,
      ...(description ? { description } : {}),
      sale_or_service_date: serviceDate ?? today,
      delivery_method: "EMAIL",
      primary_recipient: { customer_id: squareCustomerId },
      payment_requests: [
        {
          request_type: "BALANCE",
          due_date: dueDate ?? addDays(new Date(), dueDays!),
          tipping_enabled: false,
        },
      ],
      ...(acceptedPaymentMethods ? { accepted_payment_methods: acceptedPaymentMethods } : {}),
    },
  });

  return {
    orderId,
    invoiceId: invoiceResp.invoice.id,
    invoiceUrl: invoiceResp.invoice.public_url ?? null,
    squareStatus: invoiceResp.invoice.status,
  };
}

// ── Deposit invoice wrapper ──────────────────────────────────────────────────

export async function createDepositInvoice(
  params: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  const lineItems: InvoiceLineItemDraft[] = [{
    id: "deposit",
    description: "Ingredient Deposit",
    quantity: 1,
    unitPriceCents: params.depositCents,
    squareCatalogVariationId: params.depositVariationId ?? null,
  }];

  return createInvoice({
    squareCustomerId: params.squareCustomerId,
    title: params.title,
    description: params.description,
    lineItems,
    dueDate: params.dueDate,
    serviceDate: params.serviceDate,
    acceptedPaymentMethods: { card: true, bank_account: true, cash_app_pay: false, buy_now_pay_later: false },
    metadataType: "allocation-deposit",
  });
}

/**
 * Replaces an existing deposit invoice with a new one reflecting updated terms.
 * Cancel failures (already-cancelled or not-found invoice) are swallowed so
 * a stale ID in the DB doesn't block revision.
 */
export async function reviseDepositInvoice(
  oldInvoiceId: string,
  newParams: CreateDepositInvoiceParams
): Promise<DepositInvoiceResult> {
  try {
    await cancelInvoice(oldInvoiceId);
  } catch {
    // Invoice already cancelled, doesn't exist, or in a non-cancellable state.
  }
  return createDepositInvoice(newParams);
}

// ── Export invoice wrapper ───────────────────────────────────────────────────

export async function createExportInvoice(
  params: CreateExportInvoiceParams
): Promise<ExportInvoiceResult> {
  return createInvoice({
    squareCustomerId: params.squareCustomerId,
    title: params.title,
    lineItems: params.lineItems,
    dueDays: params.dueDays,
    metadataType: "export-invoice",
  });
}

// ── Shared generic operations ────────────────────────────────────────────────

/** Publishes (sends) a draft Square invoice to the recipient via email. */
export async function publishInvoice(invoiceId: string): Promise<void> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  await squarePost(`/invoices/${invoiceId}/publish`, {
    idempotency_key: crypto.randomUUID(),
    version: invoice.version,
  });
}

/** Cancels a Square invoice (must be in DRAFT or UNPAID status). */
export async function cancelInvoice(invoiceId: string): Promise<void> {
  const { invoice } = await squareGet<SquareInvoiceGetResponse>(`/invoices/${invoiceId}`);
  await squarePost(`/invoices/${invoiceId}/cancel`, { version: invoice.version });
}

/** Fetches the current status of an invoice from Square. */
export async function getInvoiceStatus(
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

/**
 * Fetches the Square Order's payment reference. Square only attaches a
 * `payment_id` to an order's tenders once the order has been paid.
 */
export async function getOrderPayment(
  orderId: string
): Promise<{ paymentId: string | null; amountPaidCents: number | null }> {
  const { order } = await squareGet<SquareOrderGetResponse>(`/orders/${orderId}`);
  const tender = order.tenders?.[0];
  return {
    paymentId: tender?.payment_id ?? null,
    amountPaidCents: tender?.amount_money?.amount ?? null,
  };
}
```

- [ ] **Step 2: Delete the old modules**

```bash
git rm lib/square/deposit-invoices.ts lib/square/export-invoices.ts
```

- [ ] **Step 3: Update `app/api/production/allocations/[id]/invoice/route.ts` imports**

Replace the import block (lines 5-12):
```ts
import {
  calculateIngredientDeposit,
  createDepositInvoice,
  publishDepositInvoice,
  reviseDepositInvoice,
  getDepositInvoiceStatus,
  getOrderPayment,
} from "@/lib/square/deposit-invoices";
```
with:
```ts
import {
  calculateIngredientDeposit,
  createDepositInvoice,
  publishInvoice,
  reviseDepositInvoice,
  getInvoiceStatus,
  getOrderPayment,
} from "@/lib/square/square-invoices";
```
Then update every call site in this file: `publishDepositInvoice(...)` → `publishInvoice(...)` (1 call site, current line 194), `getDepositInvoiceStatus(...)` → `getInvoiceStatus(...)` (2 call sites, current lines 189 and 224).

- [ ] **Step 4: Update `app/api/production/export/invoice/route.ts` import**

Replace:
```ts
import { createExportInvoice } from "@/lib/square/export-invoices";
```
with:
```ts
import { createExportInvoice } from "@/lib/square/square-invoices";
```

- [ ] **Step 5: Update `app/api/production/export/invoice-status/route.ts` import**

Replace:
```ts
import { getExportInvoiceStatus } from "@/lib/square/export-invoices";
```
with:
```ts
import { getInvoiceStatus } from "@/lib/square/square-invoices";
```
And update its one call site (current line 16): `getExportInvoiceStatus(invoiceId)` → `getInvoiceStatus(invoiceId)`.

- [ ] **Step 6: Update `app/production/components/BatchLogTab.tsx` import**

Replace:
```ts
import type { DepositCalculation } from "@/lib/square/deposit-invoices";
```
with:
```ts
import type { DepositCalculation } from "@/lib/square/square-invoices";
```

- [ ] **Step 7: Update `app/production/components/DepositInvoiceModal.tsx` import**

Replace:
```ts
import type { DepositCalculation } from "@/lib/square/deposit-invoices";
```
with:
```ts
import type { DepositCalculation } from "@/lib/square/square-invoices";
```

- [ ] **Step 8: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build, no type errors (this will surface any remaining `deposit-invoices`/`export-invoices` import left unmigrated).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: merge lib/square/deposit-invoices.ts and export-invoices.ts into square-invoices.ts"
```

---

## Task 4: Deposit invoice route — `invoice_item_mappings` lookup + per-partner due date

**Files:**
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`
- Modify: `lib/square/catalog.ts:71-95` (remove `findIngredientDepositVariationId` and its in-process cache, now dead code)
- Modify: `.env.local` (remove `SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID` if present — note for the user, don't auto-edit a gitignored file)

**Interfaces:**
- Consumes: `createDepositInvoice`, `reviseDepositInvoice`, `publishInvoice`, `getInvoiceStatus`, `getOrderPayment`, `calculateIngredientDeposit` from `@/lib/square/square-invoices` (Task 3).
- Produces: same route action shape (`generate | send | sync`), now resolving the Square item via `invoice_item_mappings` and the due date via `deposit_net_terms_days`/`deposit_invoice_due_days`.

- [ ] **Step 1: Replace the `generate` action's Square-item and due-date resolution**

In `app/api/production/allocations/[id]/invoice/route.ts`, the `generate` block currently (lines 92-116) computes `dueDate` from `batch.expected_delivery_date ?? batch.planned_brew_date` and never resolves a Square catalog item (relying on `createDepositInvoice`'s now-removed internal fallback). Also update the route's allocation fetch (line 71) to also select `contract_brewing_partners(... , deposit_net_terms_days)`.

Replace the fetch's `select` string (line 71) — add `deposit_net_terms_days` to the joined partner columns:
```ts
    .select("*, brew_batches(id, beer_name, volume_bbl, turns, recipe_id, planned_brew_date, expected_delivery_date), contract_brewing_partners(id, company_name, square_customer_id, deposit_net_terms_days)")
```
Update the `partner` cast on line 83 to include the new field:
```ts
  const partner = allocation.contract_brewing_partners as { id: string; company_name: string; square_customer_id: string | null; deposit_net_terms_days: number | null } | null;
```

Then replace the `generate` block's body (originally lines 92-116) with:
```ts
  if (action === "generate") {
    if (allocation.invoice_paid_at) {
      return NextResponse.json({ error: "Invoice has already been paid — allocation is locked" }, { status: 422 });
    }

    const calculation = await calculateIngredientDeposit(supabase, batch.id, Number(allocation.percentage));

    if (calculation.deposit_cents === 0) {
      return NextResponse.json({ error: "Deposit amount is $0 — check that recipe ingredients have costs set" }, { status: 422 });
    }

    // Resolve the Ingredient Deposit Square item: partner-specific override first, then default.
    const { data: mappingRows, error: mappingErr } = await supabase
      .from("invoice_item_mappings")
      .select("partner_id, square_catalog_item_id, square_catalog_variation_id")
      .eq("service_type", "ingredient_deposit")
      .in("partner_id", [partner.id, null]);
    if (mappingErr) return NextResponse.json({ error: mappingErr.message }, { status: 500 });
    const mapping = (mappingRows ?? []).find((m) => m.partner_id === partner.id) ?? (mappingRows ?? []).find((m) => m.partner_id === null);
    if (!mapping?.square_catalog_variation_id) {
      return NextResponse.json({ error: "Ingredient Deposit is not configured in Deposit Settings — set the Square item mapping before generating this invoice" }, { status: 422 });
    }

    // Due date: per-partner override, else global default from system_settings.
    let dueDays = partner.deposit_net_terms_days;
    if (dueDays == null) {
      const { data: setting, error: settingErr } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "deposit_invoice_due_days")
        .single();
      if (settingErr) console.error("[deposit-invoice] failed to fetch deposit_invoice_due_days setting:", settingErr);
      dueDays = (setting?.value as number) ?? 30;
    }

    const serviceDate = batch.planned_brew_date;
    const dueDate = addDaysIso(serviceDate, dueDays);
    const title = `Ingredient Deposit — ${batch.beer_name} (${Number(allocation.percentage).toFixed(1)}% allocation)`;
    const description = `Deposit for ${Number(allocation.percentage).toFixed(1)}% of ${batch.beer_name} batch. Covers ingredient costs for your allocated share.`;

    const invoiceParams = {
      squareCustomerId: partner.square_customer_id,
      title,
      description,
      depositCents: calculation.deposit_cents,
      serviceDate,
      dueDate,
      depositVariationId: mapping.square_catalog_variation_id,
    };

    const isRevision = !!allocation.square_deposit_invoice_id;
    let result;
    if (isRevision) {
      await adminSupabase
        .from("invoices")
        .update({ status: "voided" })
        .eq("source", "square")
        .eq("external_id", allocation.square_deposit_invoice_id!);

      result = await reviseDepositInvoice(allocation.square_deposit_invoice_id!, invoiceParams);
    } else {
      result = await createDepositInvoice(invoiceParams);
    }

    const { data: updated, error: updateErr } = await supabase
      .from("batch_allocations")
      .update({
        square_deposit_invoice_id: result.invoiceId,
        square_deposit_order_id: result.orderId,
        invoice_generated_at: new Date().toISOString(),
        invoice_sent_at: null,
      })
      .eq("id", id)
      .select("*")
      .single();

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const ledgerInvoiceId = await upsertFinanceLedgerInvoice(adminSupabase, {
      squareInvoiceId: result.invoiceId,
      allocationId: id,
      partnerId: partner.id,
      customerName: partner.company_name,
      invoiceDate: serviceDate,
      dueDate,
      title,
      depositCents: calculation.deposit_cents,
      status: "draft",
    });

    if (ledgerInvoiceId) {
      await adminSupabase
        .from("invoice_batch_links")
        .upsert(
          { invoice_id: ledgerInvoiceId, batch_id: batch.id },
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
    }

    return NextResponse.json({ allocation: updated, calculation, invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
  }
```

Note the new `addDaysIso` helper (date-arithmetic on an ISO date string, since `dueDays` is now relative to `serviceDate`, not `new Date()` — `createInvoice`'s `dueDate` param expects an absolute ISO date). Add this helper near the other helpers at the bottom of the file:
```ts
function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Update the `send` and `sync` actions' imports**

These two actions (current lines 174-273) already call `publishDepositInvoice`/`getDepositInvoiceStatus` — confirm the import update from Task 3 Step 3 covers them (it does, since both call sites are in this same file). No further change needed in these two blocks.

- [ ] **Step 3: Remove `findIngredientDepositVariationId` from `lib/square/catalog.ts`**

Delete lines 68-95 (the in-process cache variable and the function):
```ts
// In-process cache for the Ingredient Deposit catalog variation ID.
// Avoids a catalog fetch on every invoice generation while still recovering
// automatically if the cache is cold (new process / cold start).
let _depositVariationId: string | null | undefined = undefined;

/**
 * Returns the Square catalog variation ID for the "Ingredient Deposit" item.
 * Checks SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID env var first; falls back to
 * a case-insensitive catalog name search and caches the result in-process.
 */
export async function findIngredientDepositVariationId(): Promise<string | null> {
  const envId = process.env.SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID;
  if (envId) return envId;

  if (_depositVariationId !== undefined) return _depositVariationId;

  const items = await fetchCatalogItems();
  const match = items.find((item) =>
    item.item_data.name.toLowerCase().includes("ingredient deposit")
  );

  _depositVariationId =
    match && match.item_data.variations.length > 0
      ? match.item_data.variations[0].id
      : null;

  return _depositVariationId;
}
```
Confirm via `grep -rn "findIngredientDepositVariationId\|SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID" --include="*.ts" --include="*.tsx" .` that no other file references either name before deleting (Task 3's merged module already stopped calling it).

- [ ] **Step 4: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/allocations/[id]/invoice/route.ts lib/square/catalog.ts
git commit -m "feat: deposit invoice generate resolves Square item via invoice_item_mappings, due date via deposit_net_terms_days"
```

---

## Task 5: Export invoice route — `generate | send | sync` action dispatch, stop auto-publish, close the paid-status gap

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`
- Modify: `app/production/components/InvoicePreviewModal.tsx`

**Interfaces:**
- Consumes: `createExportInvoice`, `publishInvoice`, `getInvoiceStatus` from `@/lib/square/square-invoices` (Task 3).
- Produces: `POST /api/production/export/invoice` now takes `{ action: "generate", transactionIds, lineItems }` (creates DRAFT only, no longer publishes), `{ action: "send", transactionIds }` (publishes the shared invoice and updates `export_transactions.status` to `"unpaid"` — this already happens at generate time today; after this change it only happens at send time), `{ action: "sync", transactionIds }` (polls Square, flips `status` to `"paid"` once confirmed).

- [ ] **Step 1: Rewrite the route with action dispatch**

Replace the entire file content of `app/api/production/export/invoice/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createExportInvoice, publishInvoice, getInvoiceStatus } from "@/lib/square/square-invoices";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

interface PostBody {
  action: "generate" | "send" | "sync";
  transactionIds: string[];
  lineItems?: InvoiceLineItemDraft[];
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

  if (!["generate", "send", "sync"].includes(action)) {
    return NextResponse.json({ error: "action must be generate | send | sync" }, { status: 400 });
  }
  if (!transactionIds?.length) {
    return NextResponse.json({ error: "transactionIds is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status, square_invoice_id")
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

    // generate only creates the DRAFT — status stays invoice_required until send.
    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ square_invoice_id: result.invoiceId })
      .in("id", transactionIds);
    if (updateErr) {
      return NextResponse.json(
        { error: `Invoice ${result.invoiceId} was created in Square but updating local records failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
  }

  // ── send ──────────────────────────────────────────────────────────────────
  if (action === "send") {
    const invoiceId = txs[0].square_invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice has been generated yet — run generate first" }, { status: 400 });
    }
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "These transactions have already been sent or paid" }, { status: 400 });
    }

    const currentStatus = await getInvoiceStatus(invoiceId);
    if (currentStatus.status === "PAID") {
      return NextResponse.json({ error: "Invoice is already paid in Square — use sync to update status" }, { status: 422 });
    }
    if (currentStatus.status === "DRAFT") {
      await publishInvoice(invoiceId);
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .in("id", transactionIds);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-send Finance sync failed:", err);
    }

    return NextResponse.json({ ok: true });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    const invoiceId = txs[0].square_invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }

    const squareStatus = await getInvoiceStatus(invoiceId);

    if (squareStatus.status === "PAID") {
      const { error: updateErr } = await supabase
        .from("export_transactions")
        .update({ status: "paid" })
        .in("id", transactionIds)
        .eq("status", "unpaid");
      if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-sync Finance sync failed:", err);
    }

    return NextResponse.json({ squareStatus: squareStatus.status });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
```

This closes the confirmed gap: nothing previously ever set `export_transactions.status` to `"paid"` — `sync` now does, gated on Square actually reporting `PAID`. `generate` no longer publishes (previously `createExportInvoice` auto-published as its step 3 — Task 3's merged `createInvoice` core never publishes, so this route now needs its own explicit `send` step, matching deposit's shape exactly).

- [ ] **Step 2: Update `InvoicePreviewModal.tsx` to call `generate` explicitly and rename its button**

In `app/production/components/InvoicePreviewModal.tsx`, replace the `handleCreate` body (current lines 47-66):
```ts
  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", transactionIds, lineItems: effectiveLineItems }),
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
```
And update the submit button's label (current lines 130-133) from "Create & Send Invoice" / "Creating…" to reflect that this step only drafts the invoice — sending is now a separate step in `ExportTransactionsTab.tsx` (Task 8):
```tsx
            <button onClick={handleCreate} disabled={creating || effectiveLineItems.length === 0}
              className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-40">
              {creating ? "Generating…" : "Generate Invoice"}
            </button>
```

- [ ] **Step 3: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export/invoice/route.ts app/production/components/InvoicePreviewModal.tsx
git commit -m "feat: export invoice generate/send/sync action parity, stop auto-publish on generate, close paid-status gap"
```

---

## Task 6: Production Settings nav tree + per-partner `deposit_net_terms_days` override

**Files:**
- Modify: `app/production/nav-config.ts`
- Create: `app/production/settings/deposits/page.tsx`, `app/production/settings/export/page.tsx`
- Modify: `app/production/components/ExportTab.tsx` (remove `"settings"` tab)
- Modify: `app/finance/settings/excise-tax/page.tsx` (no import path change needed — confirmed `ExportSettingsPanel` stays at its current file path; only adding new pages, not moving it)
- Create: `app/api/production/deposit-settings/invoice-due-days/route.ts` (mirrors `app/api/production/export-settings/invoice-due-days/route.ts`)
- Modify: `app/production/components/PartnersTab.tsx`, `app/api/partners/contract-brewing/route.ts`, `app/api/partners/contract-brewing/[id]/route.ts`, `app/production/types.ts` (add `deposit_net_terms_days` per-partner override, mirroring `export_net_terms_days` exactly)
- Modify: `lib/query-keys.ts` (add `depositInvoiceDueDays` key)

**Interfaces:**
- Produces: `PRODUCTION_NAV` entry `{ href: "/production/settings", label: "Settings" }`, new `SETTINGS_NAV` export, routes `/production/settings/deposits` and `/production/settings/export`.

- [ ] **Step 1: Add the nav entries**

In `app/production/nav-config.ts`, add to `PRODUCTION_NAV` (after the `Partners` entry, line 9):
```ts
  { href: "/production/partners",  label: "Partners"  },
  { href: "/production/settings",  label: "Settings"  },
```
And add a new export at the end of the file:
```ts
export const SETTINGS_NAV: NavEntry[] = [
  { href: "/production/settings/deposits", label: "Deposit Settings" },
  { href: "/production/settings/export",   label: "Export Settings" },
];
```

- [ ] **Step 2: Create the two settings pages**

`app/production/settings/deposits/page.tsx`:
```tsx
"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import DepositSettingsPanel from "@/app/production/components/DepositSettingsPanel";

export default function DepositSettingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={SETTINGS_NAV} sticky />
      <DepositSettingsPanel />
    </main>
  );
}
```

`app/production/settings/export/page.tsx`:
```tsx
"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ProductionExportSettingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={SETTINGS_NAV} sticky />
      <ExportSettingsPanel scope="full" />
    </main>
  );
}
```

- [ ] **Step 3: Remove the `"settings"` tab from `ExportTab.tsx`**

In `app/production/components/ExportTab.tsx`:
- Remove the `ExportSettingsPanel` import (line 10).
- Change `TopTab` (line 35) from `"export_bay" | "taproom" | "export_transactions" | "settings"` to `"export_bay" | "taproom" | "export_transactions"`.
- Remove the `{ key: "settings", label: "Settings" }` entry from `TOP_TABS` (line 41).
- Remove the render line `{tab === "settings" && <ExportSettingsPanel scope="full" />}` (line 232).

- [ ] **Step 4: Create the deposit due-days API route**

`app/api/production/deposit-settings/invoice-due-days/route.ts` (exact mirror of the export one):
```ts
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
    .eq("key", "deposit_invoice_due_days")
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
    .upsert({ key: "deposit_invoice_due_days", value: days, updated_at: new Date().toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ days });
}
```

- [ ] **Step 5: Add `deposit_net_terms_days` to the partner type, queries, and API routes**

In `app/production/types.ts`, add the field to `ContractBrewingPartner` (current line 470, right after `export_net_terms_days`):
```ts
  export_net_terms_days: number | null;
  deposit_net_terms_days: number | null;
```

In `lib/query-keys.ts`, add a new key alongside `exportInvoiceDueDays` (line 52):
```ts
    exportInvoiceDueDays:  () => ["production", "export-invoice-due-days"] as const,
    depositInvoiceDueDays: () => ["production", "deposit-invoice-due-days"] as const,
```

In `app/api/partners/contract-brewing/route.ts`, add `deposit_net_terms_days` alongside `export_net_terms_days` in the `POST` handler's destructure (line 25) and insert payload (line 35):
```ts
  const { company_name, first_name, last_name, phone, address, email, notes, export_net_terms_days, deposit_net_terms_days } = body;
```
```ts
      export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null,
      deposit_net_terms_days: deposit_net_terms_days != null ? Number(deposit_net_terms_days) : null,
```

In `app/api/partners/contract-brewing/[id]/route.ts`, mirror the same in `PATCH` (line 14 destructure, line 28 update payload):
```ts
  const { company_name, first_name, last_name, phone, address, email, notes, square_customer_id, export_net_terms_days, deposit_net_terms_days } = await req.json();
```
```ts
      ...(export_net_terms_days !== undefined ? { export_net_terms_days: export_net_terms_days != null ? Number(export_net_terms_days) : null } : {}),
      ...(deposit_net_terms_days !== undefined ? { deposit_net_terms_days: deposit_net_terms_days != null ? Number(deposit_net_terms_days) : null } : {}),
```

- [ ] **Step 6: Add the field to `PartnersTab.tsx`'s edit form**

Add to `PARTNER_EMPTY` (line 19):
```ts
  export_net_terms_days: "",
  deposit_net_terms_days: "",
```
Add to `openEdit`'s form population (after line 247):
```ts
      export_net_terms_days: "export_net_terms_days" in p && p.export_net_terms_days != null ? String(p.export_net_terms_days) : "",
      deposit_net_terms_days: "deposit_net_terms_days" in p && p.deposit_net_terms_days != null ? String(p.deposit_net_terms_days) : "",
```
Add to `handleSubmit`'s payload (after line 266):
```ts
        ...(kind === "contract" ? { export_net_terms_days: form.export_net_terms_days ? Number(form.export_net_terms_days) : null } : {}),
        ...(kind === "contract" ? { deposit_net_terms_days: form.deposit_net_terms_days ? Number(form.deposit_net_terms_days) : null } : {}),
```
Add a field to the form JSX (after the `Export Net Terms` field, line 472-477):
```tsx
            {kind === "contract" && (
              <Field label="Deposit Net Terms (days)" hint="Leave blank to use the global default">
                <input type="number" min={1} max={365} className="inp" value={form.deposit_net_terms_days}
                  onChange={(e) => setForm((f) => ({ ...f, deposit_net_terms_days: e.target.value }))} />
              </Field>
            )}
```

- [ ] **Step 7: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build, new `/production/settings/deposits` and `/production/settings/export` routes present in the route list.

- [ ] **Step 8: Commit**

```bash
git add app/production/nav-config.ts app/production/settings app/production/components/ExportTab.tsx app/api/production/deposit-settings app/production/types.ts lib/query-keys.ts app/api/partners/contract-brewing app/production/components/PartnersTab.tsx
git commit -m "feat: add Production Settings nav tree, deposit_net_terms_days per-partner override"
```

---

## Task 7: `ExportSettingsPanel.tsx` bug-fix bundle + rename table refs to `invoice_item_mappings`

**Files:**
- Modify: `app/api/production/export-settings/service-mappings/route.ts` (table name only — route path unchanged to minimize churn)
- Modify: `app/production/components/ExportSettingsPanel.tsx`
- Modify: `app/production/types.ts` (`ExportServiceMapping` gains `'ingredient_deposit'` on `ServiceType`)

**Interfaces:**
- Produces: `<ExciseTaxRateRow>` with full edit controls for `name`/`receiving_party`/`unit`/`rate_usd`; `<SimpleServiceSection>`/`<BulkDiscountSection>` gain an "Add partner override" control; both reusable via a new shared `<PartnerOverridePicker>`.

- [ ] **Step 1: Update `service-mappings/route.ts` to query the renamed table and accept `ingredient_deposit`**

In `app/api/production/export-settings/service-mappings/route.ts`, change the `SERVICE_TYPES` constant (line 7):
```ts
const SERVICE_TYPES = ["packaging_fee", "keg_cleaning", "forklift", "bulk_discount", "ingredient_deposit"] as const;
```
Replace every `.from("export_service_mappings")` (lines 19, 67, 73) with `.from("invoice_item_mappings")`. Update the `PUT` handler's `row` construction (line 56) so `ingredient_deposit` doesn't get a `packaging_item_id`, mirroring the existing `bulk_discount`/`keg_cleaning` exclusions already there — no change needed since the existing ternary already only sets `packaging_item_id` when `service_type === "packaging_fee"`, so `ingredient_deposit` already falls through to `null` correctly.

- [ ] **Step 2: Add `ingredient_deposit` to the `ServiceType` union**

In `app/production/types.ts` (line 528):
```ts
export type ServiceType = "packaging_fee" | "keg_cleaning" | "forklift" | "bulk_discount" | "ingredient_deposit";
```

- [ ] **Step 3: Add full edit controls to `ExciseTaxRateRow`**

In `app/production/components/ExportSettingsPanel.tsx`, replace the `ExciseTaxRateRow` function (lines 17-65) with a version that makes `name`, `receiving_party`, `unit`, `rate_usd` editable inline (matching the existing `is_active` toggle's inline-save pattern):
```tsx
function ExciseTaxRateRow({
  rate,
  items,
  onSave,
}: {
  rate: ExciseTaxRate;
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  onSave: (id: string, patch: Partial<ExciseTaxRate>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(rate.name);
  const [party, setParty] = useState(rate.receiving_party ?? "");
  const [unit, setUnit] = useState<"bbl" | "gallon">(rate.unit);
  const [rateUsd, setRateUsd] = useState(String(rate.rate_usd));

  async function update(patch: Partial<ExciseTaxRate>) {
    setSaving(true);
    await onSave(rate.id, patch);
    setSaving(false);
  }

  function commitName() { if (name !== rate.name) update({ name }); }
  function commitParty() { if ((party || null) !== rate.receiving_party) update({ receiving_party: party || null }); }
  function commitRate() {
    const n = Number(rateUsd);
    if (!isNaN(n) && n !== rate.rate_usd) update({ rate_usd: n });
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-32" />
      </td>
      <td className="px-4 py-2.5">
        <input value={party} onChange={(e) => setParty(e.target.value)} onBlur={commitParty} placeholder="—"
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-32" />
      </td>
      <td className="px-4 py-2.5">
        <select value={unit} onChange={(e) => { const v = e.target.value as "bbl" | "gallon"; setUnit(v); update({ unit: v }); }}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
          <option value="bbl">bbl</option>
          <option value="gallon">gallon</option>
        </select>
      </td>
      <td className="px-4 py-2.5 text-right">
        <input type="number" step="0.01" value={rateUsd} onChange={(e) => setRateUsd(e.target.value)} onBlur={commitRate}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-24 text-right" />
      </td>
      <td className="px-4 py-2.5">
        <SquareCatalogSelect
          items={items}
          itemId={rate.square_catalog_item_id}
          variationId={rate.square_catalog_variation_id}
          onChange={(itemId, variationId) =>
            update({ square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
          }
        />
      </td>
      <td className="px-4 py-2.5">
        <button
          onClick={() => update({ is_active: !rate.is_active })}
          disabled={saving}
          className={`text-xs px-2 py-1 rounded border transition-colors ${
            rate.is_active
              ? "bg-emerald-900/40 border-emerald-700 text-emerald-300 hover:bg-emerald-900/60"
              : "bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {rate.is_active ? "Active" : "Inactive"}
        </button>
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Add a shared `PartnerOverridePicker` component**

Add this new component to `ExportSettingsPanel.tsx`, above `SimpleServiceSection` (before current line 291). Export it (not just local) — Task 8's `DepositSettingsPanel.tsx` reuses it for the `ingredient_deposit` mapping section:
```tsx
export function PartnerOverridePicker({ partners, excludeIds, onAdd }: {
  partners: { id: string; company_name: string }[];
  excludeIds: Set<string>;
  onAdd: (partnerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [partnerId, setPartnerId] = useState("");
  const available = partners.filter((p) => !excludeIds.has(p.id));

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-amber-500 hover:text-amber-400 transition-colors">
        + Add partner override
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
        <option value="">— select partner —</option>
        {available.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
      <button
        onClick={() => { if (partnerId) { onAdd(partnerId); setOpen(false); setPartnerId(""); } }}
        disabled={!partnerId}
        className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
      >
        Add
      </button>
      <button onClick={() => { setOpen(false); setPartnerId(""); }} className="text-xs text-zinc-500 hover:text-zinc-300">
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Wire `PartnerOverridePicker` into `SimpleServiceSection`**

Replace `SimpleServiceSection` (current lines 291-326) with:
```tsx
function SimpleServiceSection({ serviceType }: { serviceType: "keg_cleaning" | "forklift" }) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const rows = mappings.filter((m) => m.service_type === serviceType);
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: serviceType,
        partner_id: partnerId,
        display_name: PACKAGING_SERVICE_LABELS[serviceType],
        square_catalog_item_id: itemId,
        square_catalog_variation_id: variationId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">{PACKAGING_SERVICE_LABELS[serviceType]}</h4>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareCatalogSelect
            items={items}
            itemId={defaultRow?.square_catalog_item_id ?? null}
            variationId={defaultRow?.square_catalog_variation_id ?? null}
            onChange={(itemId, variationId) => upsert(defaultRow, null, itemId, variationId)}
          />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareCatalogSelect
                items={items}
                itemId={m.square_catalog_item_id}
                variationId={m.square_catalog_variation_id}
                onChange={(itemId, variationId) => upsert(m, m.partner_id, itemId, variationId)}
              />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null, null)}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Wire `PartnerOverridePicker` into `BulkDiscountSection`**

Replace `BulkDiscountSection` (current lines 328-357) with:
```tsx
function BulkDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const rows = mappings.filter((m) => m.service_type === "bulk_discount");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "bulk_discount",
        partner_id: partnerId,
        display_name: "Bulk Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Bulk Discount</h3>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareDiscountSelect discounts={discounts} value={defaultRow?.square_catalog_discount_id ?? null} onChange={(id) => upsert(defaultRow, null, id)} />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareDiscountSelect discounts={discounts} value={m.square_catalog_discount_id} onChange={(id) => upsert(m, m.partner_id, id)} />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null)}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add app/api/production/export-settings/service-mappings/route.ts app/production/components/ExportSettingsPanel.tsx app/production/types.ts
git commit -m "fix: ExportSettingsPanel excise edit controls + partner-override pickers, query renamed invoice_item_mappings table"
```

---

## Task 8: `DepositSettingsPanel.tsx` — global due days + `ingredient_deposit` mapping

**Files:**
- Create: `app/production/components/DepositSettingsPanel.tsx`
- Modify: `app/production/hooks/queries.ts` (add `useDepositInvoiceDueDaysQuery`)

**Interfaces:**
- Consumes: `PartnerOverridePicker` (exported from `ExportSettingsPanel.tsx`, Task 7), `useExportServiceMappingsQuery`, `useContractPartnersQuery`, `useExportSquareCatalogQuery` (all pre-existing, reused as-is — `invoice_item_mappings` already covers both export and deposit service types so no new query hook is needed for the mapping data itself).
- Produces: default export `DepositSettingsPanel`, used by `app/production/settings/deposits/page.tsx` (Task 6).

- [ ] **Step 1: Add the due-days query hook**

In `app/production/hooks/queries.ts`, add alongside `useExportInvoiceDueDaysQuery` (after line 208):
```ts
export function useDepositInvoiceDueDaysQuery() {
  return useQuery({
    queryKey: queryKeys.production.depositInvoiceDueDays(),
    queryFn: () => fetchJson<{ days: number }>("/api/production/deposit-settings/invoice-due-days"),
  });
}
```

- [ ] **Step 2: Write `DepositSettingsPanel.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExportServiceMappingsQuery,
  useContractPartnersQuery,
  useExportSquareCatalogQuery,
  useDepositInvoiceDueDaysQuery,
} from "../hooks/queries";
import type { ExportServiceMapping } from "../types";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";
import { PartnerOverridePicker } from "./ExportSettingsPanel";

function IngredientDepositMappingSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const rows = mappings.filter((m) => m.service_type === "ingredient_deposit");
  const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
  const overrideRows = rows.filter((m) => m.partner_id !== null);

  async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "ingredient_deposit",
        partner_id: partnerId,
        display_name: "Ingredient Deposit",
        square_catalog_item_id: itemId,
        square_catalog_variation_id: variationId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Ingredient Deposit — Square Item</h3>
      <p className="text-xs text-zinc-600 mb-2">Default Square catalog item for deposit invoices, with optional per-partner overrides.</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 italic w-28">Default</span>
          <SquareCatalogSelect
            items={items}
            itemId={defaultRow?.square_catalog_item_id ?? null}
            variationId={defaultRow?.square_catalog_variation_id ?? null}
            onChange={(itemId, variationId) => upsert(defaultRow, null, itemId, variationId)}
          />
        </div>
        {overrideRows.map((m) => {
          const partner = partners.find((p) => p.id === m.partner_id);
          return (
            <div key={m.id} className="flex items-center gap-2">
              <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
              <SquareCatalogSelect
                items={items}
                itemId={m.square_catalog_item_id}
                variationId={m.square_catalog_variation_id}
                onChange={(itemId, variationId) => upsert(m, m.partner_id, itemId, variationId)}
              />
            </div>
          );
        })}
        <PartnerOverridePicker
          partners={partners}
          excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
          onAdd={(partnerId) => upsert(null, partnerId, null, null)}
        />
      </div>
    </section>
  );
}

function DepositInvoiceTermsSection() {
  const { data } = useDepositInvoiceDueDaysQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const days = data?.days ?? 30;

  async function save() {
    const value = Number(draft || days);
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    setSaving(true);
    await fetch("/api/production/deposit-settings/invoice-due-days", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.depositInvoiceDueDays() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Default Deposit Net Terms</h3>
      <p className="text-xs text-zinc-600 mb-2">
        Days until payment is due on a generated deposit invoice, used when a partner has no override set (set per-partner in the Partners tab).
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

export default function DepositSettingsPanel() {
  return (
    <div className="flex flex-col gap-8">
      <IngredientDepositMappingSection />
      <DepositInvoiceTermsSection />
    </div>
  );
}
```

- [ ] **Step 3: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/DepositSettingsPanel.tsx app/production/hooks/queries.ts
git commit -m "feat: add DepositSettingsPanel with ingredient_deposit mapping + due-days setting"
```

---

## Task 9: `ExportTransactionsTab.tsx` — Send/Sync buttons

**Files:**
- Modify: `app/production/components/ExportTransactionsTab.tsx`

**Interfaces:**
- Consumes: `POST /api/production/export/invoice` with `{ action: "send" | "sync", transactionIds }` (Task 5).
- Produces: a small per-invoice action bar (grouped by `square_invoice_id`) rendered above each customer's transaction table, showing "Send" for draft-but-unsent invoices and "Sync" for sent-but-unconfirmed invoices, mirroring `BatchLogTab.tsx`'s `handleSendInvoice`/`handleSyncInvoice` pattern.

- [ ] **Step 1: Add grouped invoice action state + handlers**

In `app/production/components/ExportTransactionsTab.tsx`, add a helper to group transactions by `square_invoice_id` and add the send/sync handlers, right after the existing `byCustomer` construction (current line 77):

```ts
  // Group by square_invoice_id for the Send/Sync action bar — multiple
  // transactions can share one invoice (Spec 6's combined-invoice model).
  interface InvoiceGroup { invoiceId: string; txIds: string[]; status: ExportTransactionRow["status"] }
  function invoiceGroupsFor(txs: ExportTransactionRow[]): InvoiceGroup[] {
    const byInvoice = new Map<string, ExportTransactionRow[]>();
    for (const tx of txs) {
      if (!tx.square_invoice_id) continue;
      const list = byInvoice.get(tx.square_invoice_id) ?? [];
      list.push(tx);
      byInvoice.set(tx.square_invoice_id, list);
    }
    return [...byInvoice.entries()]
      .filter(([, group]) => group.some((t) => t.status !== "paid"))
      .map(([invoiceId, group]) => ({
        invoiceId,
        txIds: group.map((t) => t.id),
        status: group[0].status,
      }));
  }

  const [invoiceActionLoading, setInvoiceActionLoading] = useState<string | null>(null); // invoiceId

  async function handleSendInvoice(group: InvoiceGroup) {
    if (!confirm("Send this invoice to the customer via email?")) return;
    setInvoiceActionLoading(group.invoiceId);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", transactionIds: group.txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to send invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }

  async function handleSyncInvoice(group: InvoiceGroup) {
    setInvoiceActionLoading(group.invoiceId);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", transactionIds: group.txIds }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Failed to sync invoice");
    } finally {
      setInvoiceActionLoading(null);
    }
  }
```

- [ ] **Step 2: Render the action bar per customer group**

In the per-customer `<div>` block (current lines 102-162), insert the action bar right after the header row (after the closing `</div>` of the header at current line 120, before the `<table>`):

```tsx
            {invoiceGroupsFor(txs).map((group) => (
              <div key={group.invoiceId} className="flex items-center justify-between px-4 py-1.5 bg-zinc-900/40 border-b border-zinc-800/60 text-xs">
                <span className="text-zinc-500">
                  Invoice {group.invoiceId.slice(0, 8)}… — {group.status === "invoice_required" ? "Draft, not yet sent" : "Sent, awaiting payment"}
                </span>
                <button
                  onClick={() => group.status === "invoice_required" ? handleSendInvoice(group) : handleSyncInvoice(group)}
                  disabled={invoiceActionLoading === group.invoiceId}
                  className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors disabled:opacity-40"
                >
                  {invoiceActionLoading === group.invoiceId ? "Working…" : group.status === "invoice_required" ? "Send" : "Sync"}
                </button>
              </div>
            ))}
```

- [ ] **Step 3: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/ExportTransactionsTab.tsx
git commit -m "feat: add Send/Sync action bar to ExportTransactionsTab, mirroring deposit invoice flow"
```

---

## Task 10: `commitment_packaging_preferences` strict consumption — types, API, `CommitmentsTab.tsx`

**Files:**
- Modify: `app/production/types.ts`
- Modify: `app/api/production/contract-requests/route.ts`
- Modify: `app/production/components/intake/CommitmentsTab.tsx`

**Interfaces:**
- Consumes: `useRecipePackagingVariationsQuery()` (pre-existing, returns `RecipePackagingVariation[]`), `PackagingVariation.total_volume_fl_oz` (pre-existing, Spec 10).
- Produces: `CommitmentPackagingPreference.variation_id` (replaces `packaging_item_id`), commitment write payload shape `{ variation_id, qty }` (replaces `{ packaging_item_id, qty }`).

- [ ] **Step 1: Update `CommitmentPackagingPreference` type**

In `app/production/types.ts`, replace the `CommitmentPackagingPreference` interface (current lines 300-307):
```ts
export interface CommitmentPackagingPreference {
  id: string;
  commitment_id: string;
  variation_id: string;
  qty: number;
  created_at: string;
  packaging_variations?: PackagingVariation | null;
}
```

- [ ] **Step 2: Update `contract-requests/route.ts`'s packaging payload shape and joins**

Replace the file's packaging-handling section (current lines 8-29):
```ts
interface PackagingPrefInput {
  variation_id: string;
  qty: number;
}

function parsePackaging(b: Record<string, unknown>): PackagingPrefInput[] | undefined {
  if (!Array.isArray(b.packaging)) return undefined;
  return (b.packaging as Array<{ variation_id?: string; qty?: number | string }>)
    .filter((p) => p.variation_id && p.qty != null && Number(p.qty) > 0)
    .map((p) => ({ variation_id: p.variation_id as string, qty: Number(p.qty) }));
}

async function replacePackagingPreferences(supabase: SupabaseClient, commitmentId: string, prefs: PackagingPrefInput[]) {
  await supabase.from("commitment_packaging_preferences").delete().eq("commitment_id", commitmentId);
  if (prefs.length === 0) return;
  await supabase.from("commitment_packaging_preferences").insert(
    prefs.map((p) => ({ commitment_id: commitmentId, variation_id: p.variation_id, qty: p.qty }))
  );
}

const COMMITMENT_SELECT = `*, recipes(beer_name), contract_brewing_partners(company_name),
  commitment_packaging_preferences(id, commitment_id, variation_id, qty, created_at, packaging_variations(id, name, total_volume_fl_oz, container_id, format))`;
```

- [ ] **Step 3: Update `CommitmentsTab.tsx`'s `PackagingRow` type and form state**

In `app/production/components/intake/CommitmentsTab.tsx`, replace the `PackagingRow` interface and `EMPTY_PACKAGING_ROW` constant (current lines 134-156):
```ts
interface PackagingRow {
  variation_id: string;
  qty: string;
}
```
```ts
const EMPTY_PACKAGING_ROW: PackagingRow = { variation_id: "", qty: "" };
```

- [ ] **Step 4: Replace the free-pick packaging select with the recipe-scoped declared-variation picker**

In `CommitmentModal`, replace the `usePackagingQuery()` import usage and the `kegs`/`cans` derivation (current lines 14, 181-182, 204-205) — swap the import:
```ts
import { fetchJson, useRecipePackagingVariationsQuery } from "../../hooks/queries";
```
and replace:
```ts
  const { data: packaging = [] } = usePackagingQuery();
```
with:
```ts
  const { data: recipePackagingVariations = [] } = useRecipePackagingVariationsQuery();
```
Replace the `kegs`/`cans` derivation (current lines 204-205):
```ts
  const recipeVariations = recipePackagingVariations
    .filter((rv) => rv.recipe_id === form.recipe_id)
    .map((rv) => rv.packaging_variations)
    .filter((v): v is PackagingVariation => v != null && v.is_active);
  const kegs = recipeVariations.filter((v) => v.container?.type === "keg");
  const cans = recipeVariations.filter((v) => v.container?.type === "can");
```
Add the `PackagingVariation` type import to the file's existing type import line (current line 5, wherever `Recipe`/`ContractBrewingRequest` etc. are imported from `"../../types"`) — add `PackagingVariation` to that import list.

- [ ] **Step 5: Clear stale `variation_id` selections when `recipe_id` changes**

Add a `useEffect` in `CommitmentModal`, right after the `recipeVariations`/`kegs`/`cans` derivation from Step 4:
```ts
  useEffect(() => {
    const validIds = new Set(recipeVariations.map((v) => v.id));
    setForm((f) => {
      const next = f.packaging.map((row) =>
        row.variation_id && !validIds.has(row.variation_id) ? { ...row, variation_id: "" } : row
      );
      return next.some((row, i) => row.variation_id !== f.packaging[i].variation_id) ? { ...f, packaging: next } : f;
    });
    // Only re-run when the recipe (and therefore the declared-variation set) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.recipe_id]);
```
Add `useEffect` to the existing `import { useState } from "react";` line at the top of the file (current line 1 area) — change to `import { useState, useEffect } from "react";`.

- [ ] **Step 6: Update `rowBbl`, the packaging row selects, and the submit payload**

Replace `rowBbl` (current lines 220-224):
```ts
  function rowBbl(row: PackagingRow): number | null {
    const variation = recipeVariations.find((v) => v.id === row.variation_id);
    const qty = parseFloat(row.qty);
    if (!variation?.total_volume_fl_oz || !qty) return null;
    return (qty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
  }
```
Replace `setPackagingRow`'s patch type usage is unaffected (still keyed by index + partial row), but the row select JSX (current lines 356-368) becomes:
```tsx
                  <select className="inp" value={row.variation_id} onChange={(e) => setPackagingRow(i, { variation_id: e.target.value })}>
                    <option value="">— not specified —</option>
                    {kegs.length > 0 && (
                      <optgroup label="Kegs">
                        {kegs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </optgroup>
                    )}
                    {cans.length > 0 && (
                      <optgroup label="Cans">
                        {cans.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </optgroup>
                    )}
                  </select>
```
Replace the submit payload's `packagingPayload` construction (current lines 234-236):
```ts
      const packagingPayload = form.packaging
        .filter((r) => r.variation_id && r.qty)
        .map((r) => ({ variation_id: r.variation_id, qty: parseFloat(r.qty) }));
```
And update the pre-population from `existing` (current line 195, inside the `existing ? {...}` form-init block):
```ts
    packaging: existing.packaging_preferences && existing.packaging_preferences.length > 0
      ? existing.packaging_preferences.map((p) => ({ variation_id: p.variation_id, qty: String(p.qty) }))
      : [{ ...EMPTY_PACKAGING_ROW }],
```

- [ ] **Step 7: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.
```bash
npm run build
```
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add app/production/types.ts app/api/production/contract-requests/route.ts app/production/components/intake/CommitmentsTab.tsx
git commit -m "feat: rekey commitment_packaging_preferences UI/API to strict recipe_packaging_variations picking"
```

---

## Task 11: Final whole-branch verification

**Files:** none (verification only)

- [ ] **Step 1: Full lint + build pass**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings across every file touched by this plan.
```bash
npm run build
```
Expected: clean build; confirm `/production/settings`, `/production/settings/deposits`, `/production/settings/export` all appear in the route output and `/production/export` no longer references a `settings` tab.

- [ ] **Step 2: Grep for dead references**

```bash
grep -rn "export_service_mappings\|deposit-invoices\|export-invoices\b\|findIngredientDepositVariationId\|SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID\|packaging_item_id" --include="*.ts" --include="*.tsx" app lib | grep -v "node_modules"
```
Expected: zero hits for `export_service_mappings`, `deposit-invoices`, `export-invoices`, `findIngredientDepositVariationId`, `SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID`. The `packaging_item_id` grep is expected to still show real hits elsewhere in the codebase (e.g. `export_transactions.packaging_item_id`, `invoice_item_mappings.packaging_item_id`, `cold_storage_inventory` history) — confirm none of those hits are inside `commitment_packaging_preferences`-related files (`CommitmentsTab.tsx`, `contract-requests/route.ts`, the `CommitmentPackagingPreference` type).

- [ ] **Step 3: Direct REST spot-checks against the live database**

```bash
curl -s "https://drlsazatrcrdwaihjmex.supabase.co/rest/v1/invoice_item_mappings?service_type=eq.ingredient_deposit&select=*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `200`, empty array (no mapping configured yet) — confirms the check constraint accepts the new service type without error once a row is written via the new Deposit Settings UI.

- [ ] **Step 4: Manual UI checklist (cannot be scripted — no test runner in this repo)**

Note honestly in the final summary which of these were actually exercised through the running app vs. verified by code review only:
- `/production/settings` nav entry appears; Deposit Settings and Export Settings sub-tabs both render.
- Deposit Settings: set a default Ingredient Deposit Square item mapping, add a partner override, set the global due-days default.
- Export Settings: confirm Excise Tax Rates rows are now editable inline for name/receiving party/unit/rate; confirm Keg Cleaning/Forklift/Bulk Discount each show a working "+ Add partner override" control.
- Commitments (Intake tab): create or edit a commitment, select a recipe, confirm the packaging-preference selects only list that recipe's declared `recipe_packaging_variations` (not all keg/can `packaging_items`); change the recipe selection and confirm any previously-selected variation not in the new recipe's declared set gets cleared.
- If any unpaid `batch_allocations` row exists: run deposit invoice generate → confirm it resolves the Square item from Deposit Settings' mapping (no more env var/dead-code fallback) and the due date matches the per-partner override or global default.
- If any `invoice_required` `export_transactions` rows exist: run Generate Invoice (confirm it now only creates a DRAFT, no auto-send), then use the new Send button (confirm it actually publishes to Square), then Sync (confirm `status` flips to `paid` once Square reports payment — this is the gap being closed).

- [ ] **Step 5: Confirm no stray local commits before finishing**

```bash
git log --oneline -15
git status
```
Expected: a clean, linear sequence of this plan's commits on top of `main`'s current HEAD, no uncommitted changes, no stray files.

---

## Self-review notes (plan author)

- **Spec coverage**: Part A (module merge) → Task 3. Part B (schema) → Task 1. Part C (routes) → Tasks 4-5. Part D (UI/nav) → Tasks 6, 8, 9. Part E (bug-fix bundle) → Task 7. Part F (packaging strict consumption) → Tasks 2, 10. All six spec parts have at least one task.
- **Out-of-scope reminder for the implementer**: per the spec's explicit deferral, no task in this plan touches `calculateIngredientDeposit`'s cost formula to add packaging cost — Task 10 is rekey/UI only.
- **Sequencing**: Tasks 1-2 (schema) must land before Tasks 4, 5, 7, 10 (their consumers) — execute in the numbered order. Task 3 (module merge) must land before Tasks 4-5 (which import from the merged module).
