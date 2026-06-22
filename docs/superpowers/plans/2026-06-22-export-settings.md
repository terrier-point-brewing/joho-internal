# Export Settings + Barrel Excise Tax Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable Customer/Packaging × Service → Square Catalog mapping system (`export_service_mappings`) plus Square-item mapping on existing `excise_tax_rates`, surfaced via a shared `ExportSettingsPanel` component mounted under Production > Export > Settings (full) and Finance > Settings > Excise Tax (excise-only).

**Architecture:** Two new/modified Postgres tables, three new thin CRUD API routes under `app/api/production/export-settings/`, a small catalog-discount addition to `lib/square/catalog.ts`, a reusable `SquareCatalogSelect`/`SquareDiscountSelect` picker in `app/components/`, and one shared `ExportSettingsPanel` component rendered from two entry points. No invoice-generation logic — that is Spec 6's job.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, `@tanstack/react-query`, Supabase Postgres (admin client, RLS bypass for service-role routes), Square Catalog API via `lib/square/client.ts`.

## Global Constraints

- No test runner exists in this repo — verification is `npm run lint` + `npm run build` + manual code review per task, never a test suite. (Project Lesson #1)
- Write access to every new route is gated to exactly `{brewer, admin}` via `requireRole(["brewer"])` (admin is always implicit per `lib/auth.ts`). Reads are gated to `requireRole(["viewer"])` (open to all authenticated roles, admin implicit).
- New migration file: `supabase/migrations/20260624_export_settings.sql`. Per Lesson #2, this plan does NOT run `supabase db push`/`migration repair` — the last task asks the user to paste the SQL into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex` and confirm, then a follow-up `insert into supabase_migrations.schema_migrations (version) values ('20260624') on conflict (version) do nothing;` is run the same way.
- All new admin-client Supabase access goes through `createSupabaseAdminClient()` from `lib/supabase/admin.ts`, matching the existing `account-mappings` route pattern — never the browser or server (cookie) client in a route handler.
- No invoice-generation logic, no changes to `export_transactions` status flow, no changes to `commitments`/`batch_allocations` schemas (explicit non-goals from the spec).

---

## File Structure

- **Modify** `supabase/migrations/20260624_export_settings.sql` (new file) — schema.
- **Modify** `types/square.ts` — add `CatalogDiscount` type + extend `CatalogObject` union.
- **Modify** `lib/square/catalog.ts` — add `fetchCatalogDiscounts`.
- **Create** `app/api/production/export-settings/excise-tax-rates/route.ts` — GET list, POST create.
- **Create** `app/api/production/export-settings/excise-tax-rates/[id]/route.ts` — PATCH edit/deactivate, DELETE.
- **Create** `app/api/production/export-settings/service-mappings/route.ts` — GET list (filterable), PUT upsert.
- **Create** `app/api/production/export-settings/square-catalog/route.ts` — GET proxy (items + variations + discounts).
- **Modify** `app/production/types.ts` — add `ExciseTaxRate`, `ExportServiceMapping`, `ServiceType` types.
- **Modify** `lib/query-keys.ts` — add `production.exciseTaxRates`, `production.exportServiceMappings`, `production.exportSquareCatalog` keys.
- **Modify** `app/production/hooks/queries.ts` — add `useExciseTaxRatesQuery`, `useExportServiceMappingsQuery`, `useExportSquareCatalogQuery`.
- **Create** `app/components/SquareCatalogSelect.tsx` — reusable item/variation picker + sibling `SquareDiscountSelect`.
- **Create** `app/production/components/ExportSettingsPanel.tsx` — the shared 3-section panel (excise tax / service mappings / bulk discount), accepting a `scope: "full" | "excise-only"` prop.
- **Modify** `app/production/components/ExportTab.tsx` — add a "Settings" top-level tab.
- **Create** `app/finance/settings/excise-tax/page.tsx` — renders `ExportSettingsPanel` with `scope="excise-only"`.
- **Modify** `app/finance/settings/SettingsNav.tsx` — add "Excise Tax" sub-tab link.

---

### Task 1: Schema migration — `excise_tax_rates` columns + `export_service_mappings` table

**Files:**
- Create: `supabase/migrations/20260624_export_settings.sql`

**Interfaces:**
- Produces: columns `excise_tax_rates.square_catalog_item_id text`, `excise_tax_rates.square_catalog_variation_id text`; table `export_service_mappings` exactly as specified below, consumed by Tasks 3–4's routes and Task 9's UI.

- [ ] **Step 1: Write the migration file**

```sql
-- Spec 7: Export Settings + Barrel Excise Tax Settings
-- Adds Square Line Item mapping to excise_tax_rates, and a new
-- Customer/Packaging x Service -> Square Item mapping table.

alter table public.excise_tax_rates
  add column square_catalog_item_id text,
  add column square_catalog_variation_id text;

create table public.export_service_mappings (
  id                            uuid primary key default gen_random_uuid(),
  service_type                  text not null check (service_type in (
                                   'packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount'
                                 )),
  partner_id                    uuid references public.contract_brewing_partners(id) on delete cascade,
  packaging_item_id             uuid references public.packaging_items(id) on delete cascade,
  square_catalog_item_id        text,
  square_catalog_variation_id   text,
  square_catalog_discount_id    text,
  display_name                  text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (service_type, partner_id, packaging_item_id),
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
  )
);

create index export_service_mappings_lookup_idx
  on public.export_service_mappings (service_type, partner_id, packaging_item_id);
```

- [ ] **Step 2: Self-review the SQL against the spec**

Re-read `docs/superpowers/specs/2026-06-21-export-settings-design.md`'s "Data Model" section side-by-side with the file above. Confirm: column names match exactly, the CHECK constraint's three branches match the three `service_type` groupings, the `unique` constraint matches `(service_type, partner_id, packaging_item_id)`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260624_export_settings.sql
git commit -m "feat: add export_service_mappings table + excise_tax_rates Square mapping columns"
```

(Per Lesson #2, do NOT run `supabase db push` here — applying this migration to the live database happens in Task 11, after all code that depends on it is written and reviewed.)

---

### Task 2: Square catalog discount support

**Files:**
- Modify: `types/square.ts`
- Modify: `lib/square/catalog.ts`

**Interfaces:**
- Produces: `CatalogDiscount` type, `fetchCatalogDiscounts(): Promise<CatalogDiscount[]>` — consumed by Task 5's `square-catalog` route.

- [ ] **Step 1: Add the `CatalogDiscount` type**

In `types/square.ts`, after the `CatalogTax` interface (currently ending at line 67) and before `ComboSlot`:

```typescript
export interface CatalogDiscount {
  type: "DISCOUNT";
  id: string;
  discount_data: {
    name: string;
    discount_type?: string;      // FIXED_PERCENTAGE | FIXED_AMOUNT | VARIABLE_PERCENTAGE | VARIABLE_AMOUNT
    percentage?: string;
    amount_money?: Money;
  };
}
```

Then update the `CatalogObject` union (currently line 107) to include it:

```typescript
export type CatalogObject = CatalogItem | CatalogItemVariation | CatalogCategory | CatalogTax | CatalogDiscount | { type: string; id: string };
```

- [ ] **Step 2: Add `fetchCatalogDiscountsUncached` + cached export**

In `lib/square/catalog.ts`, after `fetchCatalogTaxes` (ends at line 41), add:

```typescript
async function fetchCatalogDiscountsUncached(): Promise<CatalogDiscount[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "DISCOUNT" });
  return objects.filter((o): o is CatalogDiscount => o.type === "DISCOUNT");
}

export const fetchCatalogDiscounts = unstable_cache(
  fetchCatalogDiscountsUncached,
  ["square-catalog-discounts"],
  { revalidate: 300, tags: ["square-catalog"] },
);
```

Update the import line at the top of the file to include `CatalogDiscount`:

```typescript
import type { CatalogObject, CatalogItem, CatalogCategory, CatalogTax, CatalogDiscount } from "@/types/square";
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds with no type errors (confirms the new union member doesn't break any exhaustive `CatalogObject` switch elsewhere — if it does, grep for `CatalogObject` usages and add a `DISCOUNT` branch).

- [ ] **Step 4: Commit**

```bash
git add types/square.ts lib/square/catalog.ts
git commit -m "feat: add Square catalog discount fetching"
```

---

### Task 3: Excise tax rates CRUD API

**Files:**
- Create: `app/api/production/export-settings/excise-tax-rates/route.ts`
- Create: `app/api/production/export-settings/excise-tax-rates/[id]/route.ts`

**Interfaces:**
- Consumes: `requireRole` from `lib/auth.ts`, `createSupabaseAdminClient` from `lib/supabase/admin.ts`.
- Produces: `GET /api/production/export-settings/excise-tax-rates` → `ExciseTaxRate[]`; `POST` same path (body without `id`) → created row; `PATCH /api/production/export-settings/excise-tax-rates/:id` → updated row; `DELETE` same → `{ deleted: true }`. Shape consumed by Task 6's hook and Task 9's UI.

- [ ] **Step 1: Write the list/create route**

```typescript
// app/api/production/export-settings/excise-tax-rates/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("excise_tax_rates")
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, created_at, updated_at")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    name: string;
    receiving_party?: string | null;
    unit: "bbl" | "gallon";
    rate_usd: number;
    square_catalog_item_id?: string | null;
    square_catalog_variation_id?: string | null;
  };

  if (!body.name || !body.unit || body.rate_usd == null) {
    return NextResponse.json({ error: "name, unit, and rate_usd are required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("excise_tax_rates")
    .insert({
      name: body.name,
      receiving_party: body.receiving_party ?? null,
      unit: body.unit,
      rate_usd: body.rate_usd,
      square_catalog_item_id: body.square_catalog_item_id ?? null,
      square_catalog_variation_id: body.square_catalog_variation_id ?? null,
    })
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 2: Write the `[id]` edit/delete route**

```typescript
// app/api/production/export-settings/excise-tax-rates/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
  const { id } = await params;

  const body = await req.json() as Partial<{
    name: string;
    receiving_party: string | null;
    unit: "bbl" | "gallon";
    rate_usd: number;
    is_active: boolean;
    square_catalog_item_id: string | null;
    square_catalog_variation_id: string | null;
  }>;

  const patch: Record<string, unknown> = {};
  for (const key of ["name", "receiving_party", "unit", "rate_usd", "is_active", "square_catalog_item_id", "square_catalog_variation_id"] as const) {
    if (key in body) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("excise_tax_rates")
    .update(patch)
    .eq("id", id)
    .select("id, name, receiving_party, unit, rate_usd, is_active, square_catalog_item_id, square_catalog_variation_id, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
  const { id } = await params;

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("excise_tax_rates").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds. Next.js 16's route handler `params` is a `Promise` (per this repo's `AGENTS.md` warning about breaking API changes) — confirm no type error on the `{ params }` destructure.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export-settings/excise-tax-rates
git commit -m "feat: add excise tax rates CRUD API"
```

---

### Task 4: Service mappings list/upsert API

**Files:**
- Create: `app/api/production/export-settings/service-mappings/route.ts`

**Interfaces:**
- Produces: `GET /api/production/export-settings/service-mappings?service_type=...&partner_id=...` → `ExportServiceMapping[]`; `PUT` same path (body: full row incl. optional `id`) → upserted row. Consumed by Task 6's hook and Task 9's UI.

- [ ] **Step 1: Write the route**

```typescript
// app/api/production/export-settings/service-mappings/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const SERVICE_TYPES = ["packaging_fee", "keg_cleaning", "forklift", "bulk_discount"] as const;
type ServiceType = typeof SERVICE_TYPES[number];

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const { searchParams } = new URL(req.url);
  const serviceType = searchParams.get("service_type");
  const partnerId = searchParams.get("partner_id");

  const supabase = createSupabaseAdminClient();
  let query = supabase
    .from("export_service_mappings")
    .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
    .order("service_type")
    .order("display_name");

  if (serviceType) query = query.eq("service_type", serviceType);
  if (partnerId) query = query.eq("partner_id", partnerId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function PUT(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const body = await req.json() as {
    id?: string;
    service_type: ServiceType;
    partner_id?: string | null;
    packaging_item_id?: string | null;
    square_catalog_item_id?: string | null;
    square_catalog_variation_id?: string | null;
    square_catalog_discount_id?: string | null;
    display_name: string;
  };

  if (!SERVICE_TYPES.includes(body.service_type)) {
    return NextResponse.json({ error: "Invalid service_type" }, { status: 400 });
  }
  if (!body.display_name) {
    return NextResponse.json({ error: "display_name is required" }, { status: 400 });
  }

  const row = {
    service_type: body.service_type,
    partner_id: body.partner_id ?? null,
    packaging_item_id: body.service_type === "packaging_fee" ? (body.packaging_item_id ?? null) : null,
    square_catalog_item_id: body.service_type === "bulk_discount" ? null : (body.square_catalog_item_id ?? null),
    square_catalog_variation_id: body.service_type === "bulk_discount" ? null : (body.square_catalog_variation_id ?? null),
    square_catalog_discount_id: body.service_type === "bulk_discount" ? (body.square_catalog_discount_id ?? null) : null,
    display_name: body.display_name,
    updated_at: new Date().toISOString(),
  };

  const supabase = createSupabaseAdminClient();
  const { data, error } = body.id
    ? await supabase
        .from("export_service_mappings")
        .update(row)
        .eq("id", body.id)
        .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single()
    : await supabase
        .from("export_service_mappings")
        .upsert(row, { onConflict: "service_type,partner_id,packaging_item_id" })
        .select("id, service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name, created_at, updated_at")
        .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

Note: the CHECK constraint's enforcement of which Square-object columns must be non-null per `service_type` means a partial PATCH-style update from this single `PUT` will fail at the DB layer if it leaves a row in an invalid state (e.g. clearing `square_catalog_item_id` on a `keg_cleaning` row without also nulling its `square_catalog_variation_id` is fine, but setting only one of the two for a fresh `packaging_fee` row is not) — the route trusts the caller (`ExportSettingsPanel`) to always send a complete, valid row, matching how the spec describes this as full-row upsert, not field-level PATCH like the excise-tax-rates route.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export-settings/service-mappings
git commit -m "feat: add export service mappings list/upsert API"
```

---

### Task 5: Square catalog proxy API

**Files:**
- Create: `app/api/production/export-settings/square-catalog/route.ts`

**Interfaces:**
- Consumes: `fetchCatalogItems`, `fetchCatalogDiscounts` (Task 2), `buildVariationNameMap` from `lib/square/catalog.ts`.
- Produces: `GET /api/production/export-settings/square-catalog` → `{ items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[]; discounts: { id: string; name: string }[] }`, consumed by Task 6's hook and Task 7's picker components.

- [ ] **Step 1: Write the route**

```typescript
// app/api/production/export-settings/square-catalog/route.ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { fetchCatalogItems, fetchCatalogDiscounts } from "@/lib/square/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

  const [items, discounts] = await Promise.all([fetchCatalogItems(), fetchCatalogDiscounts()]);

  const itemOptions = items
    .filter((item) => !item.item_data.is_archived)
    .map((item) => ({
      itemId: item.id,
      itemName: item.item_data.name,
      variations: (item.item_data.variations ?? []).map((v) => ({
        variationId: v.id,
        variationName: v.item_variation_data.name,
      })),
    }));

  const discountOptions = discounts.map((d) => ({ id: d.id, name: d.discount_data.name }));

  return NextResponse.json({ items: itemOptions, discounts: discountOptions });
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export-settings/square-catalog
git commit -m "feat: add Square catalog proxy for export settings pickers"
```

---

### Task 6: Types, query keys, and React Query hooks

**Files:**
- Modify: `app/production/types.ts`
- Modify: `lib/query-keys.ts`
- Modify: `app/production/hooks/queries.ts`

**Interfaces:**
- Produces: `ExciseTaxRate`, `ExportServiceMapping`, `ServiceType`, `SquareCatalogOptions` types; `queryKeys.production.exciseTaxRates()`, `.exportServiceMappings()`, `.exportSquareCatalog()`; `useExciseTaxRatesQuery()`, `useExportServiceMappingsQuery()`, `useExportSquareCatalogQuery()`. Consumed by Task 9's `ExportSettingsPanel` and Task 7's picker components.

- [ ] **Step 1: Add types to `app/production/types.ts`**

Append at the end of the file:

```typescript
export type ServiceType = "packaging_fee" | "keg_cleaning" | "forklift" | "bulk_discount";

export interface ExciseTaxRate {
  id: string;
  name: string;
  receiving_party: string | null;
  unit: "bbl" | "gallon";
  rate_usd: number;
  is_active: boolean;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportServiceMapping {
  id: string;
  service_type: ServiceType;
  partner_id: string | null;
  packaging_item_id: string | null;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  square_catalog_discount_id: string | null;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface SquareCatalogOptions {
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  discounts: { id: string; name: string }[];
}
```

- [ ] **Step 2: Add query keys to `lib/query-keys.ts`**

In the `production` object (after `ingredientShortfalls`, the last existing entry), add:

```typescript
    exciseTaxRates:        () => ["production", "excise-tax-rates"] as const,
    exportServiceMappings: () => ["production", "export-service-mappings"] as const,
    exportSquareCatalog:   () => ["production", "export-square-catalog"] as const,
```

- [ ] **Step 3: Add hooks to `app/production/hooks/queries.ts`**

After `useSuppliersQuery` (around line 162), add:

```typescript
export function useExciseTaxRatesQuery() {
  return useQuery({
    queryKey: queryKeys.production.exciseTaxRates(),
    queryFn: () => fetchJson<ExciseTaxRate[]>("/api/production/export-settings/excise-tax-rates"),
  });
}

export function useExportServiceMappingsQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportServiceMappings(),
    queryFn: () => fetchJson<ExportServiceMapping[]>("/api/production/export-settings/service-mappings"),
  });
}

export function useExportSquareCatalogQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportSquareCatalog(),
    queryFn: () => fetchJson<SquareCatalogOptions>("/api/production/export-settings/square-catalog"),
  });
}
```

Update the type import at the top of the file to add `ExciseTaxRate, ExportServiceMapping, SquareCatalogOptions`:

```typescript
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier, ExciseTaxRate, ExportServiceMapping, SquareCatalogOptions,
} from "../types";
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/production/types.ts lib/query-keys.ts app/production/hooks/queries.ts
git commit -m "feat: add export settings types, query keys, and hooks"
```

---

### Task 7: `SquareCatalogSelect` + `SquareDiscountSelect` shared picker components

**Files:**
- Create: `app/components/SquareCatalogSelect.tsx`

**Interfaces:**
- Consumes: `SquareCatalogOptions` type (Task 6).
- Produces: `SquareCatalogSelect({ items, itemId, variationId, onChange })` and `SquareDiscountSelect({ discounts, value, onChange })`, consumed by Task 9's `ExportSettingsPanel`.

- [ ] **Step 1: Write the component**

Modeled on `AccountSelect` in `app/finance/settings/account-mapping/page.tsx:80-217`, but simplified to a two-level (item → variation) cascading select since there's no search/grouping requirement in the spec for this picker.

```typescript
"use client";

import { useState } from "react";
import type { SquareCatalogOptions } from "@/app/production/types";

export function SquareCatalogSelect({
  items,
  itemId,
  variationId,
  onChange,
}: {
  items: SquareCatalogOptions["items"];
  itemId: string | null;
  variationId: string | null;
  onChange: (itemId: string | null, variationId: string | null) => void;
}) {
  const selectedItem = items.find((i) => i.itemId === itemId) ?? null;

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={itemId ?? ""}
        onChange={(e) => {
          const newItemId = e.target.value || null;
          onChange(newItemId, null);
        }}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
      >
        <option value="">— select item —</option>
        {items.map((i) => (
          <option key={i.itemId} value={i.itemId}>{i.itemName}</option>
        ))}
      </select>
      <select
        value={variationId ?? ""}
        disabled={!selectedItem}
        onChange={(e) => onChange(itemId, e.target.value || null)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 disabled:opacity-40 focus:outline-none focus:border-amber-600"
      >
        <option value="">— select variation —</option>
        {(selectedItem?.variations ?? []).map((v) => (
          <option key={v.variationId} value={v.variationId}>{v.variationName}</option>
        ))}
      </select>
    </div>
  );
}

export function SquareDiscountSelect({
  discounts,
  value,
  onChange,
}: {
  discounts: SquareCatalogOptions["discounts"];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [draft] = useState(value);
  void draft; // controlled component, no local-only state needed beyond the select itself

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
    >
      <option value="">— select discount —</option>
      {discounts.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}
```

Self-correction: the unused `draft`/`useState` in `SquareDiscountSelect` is dead weight — it's a fully controlled component and needs no local state. Remove it:

```typescript
export function SquareDiscountSelect({
  discounts,
  value,
  onChange,
}: {
  discounts: SquareCatalogOptions["discounts"];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-600"
    >
      <option value="">— select discount —</option>
      {discounts.map((d) => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  );
}
```

Drop the `useState` import (no longer needed) — the final file has no `useState` import at all.

- [ ] **Step 2: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: both pass — confirms no unused-import/unused-variable errors from the self-correction in Step 1.

- [ ] **Step 3: Commit**

```bash
git add app/components/SquareCatalogSelect.tsx
git commit -m "feat: add reusable Square catalog item/variation/discount picker"
```

---

### Task 8: `ExportSettingsPanel` — Excise Tax Rates section

**Files:**
- Create: `app/production/components/ExportSettingsPanel.tsx`

**Interfaces:**
- Consumes: `useExciseTaxRatesQuery`, `useExportSquareCatalogQuery` (Task 6), `SquareCatalogSelect` (Task 7), `ExciseTaxRate` type (Task 6).
- Produces: default export `ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" })`, consumed by Task 10's `ExportTab.tsx` and `app/finance/settings/excise-tax/page.tsx`. This task builds only the excise-tax section and the panel shell; Task 9 adds sections 2–3 for `scope === "full"`.

- [ ] **Step 1: Write the panel shell + Excise Tax Rates CRUD section**

```typescript
"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useExciseTaxRatesQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import type { ExciseTaxRate } from "../types";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

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

  async function update(patch: Partial<ExciseTaxRate>) {
    setSaving(true);
    await onSave(rate.id, patch);
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5 text-zinc-200">{rate.name}</td>
      <td className="px-4 py-2.5 text-zinc-400">{rate.receiving_party ?? "—"}</td>
      <td className="px-4 py-2.5 text-zinc-400">{rate.unit}</td>
      <td className="px-4 py-2.5 text-right text-zinc-200">${rate.rate_usd.toFixed(2)}</td>
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

function ExciseTaxRatesSection() {
  const qc = useQueryClient();
  const { data: rates = [] } = useExciseTaxRatesQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftParty, setDraftParty] = useState("");
  const [draftUnit, setDraftUnit] = useState<"bbl" | "gallon">("bbl");
  const [draftRate, setDraftRate] = useState("");

  const items = catalog?.items ?? [];

  async function refresh() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.exciseTaxRates() });
  }

  async function save(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/production/export-settings/excise-tax-rates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }

  async function create() {
    if (!draftName || !draftRate) return;
    await fetch("/api/production/export-settings/excise-tax-rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draftName,
        receiving_party: draftParty || null,
        unit: draftUnit,
        rate_usd: Number(draftRate),
      }),
    });
    setCreating(false);
    setDraftName(""); setDraftParty(""); setDraftUnit("bbl"); setDraftRate("");
    await refresh();
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-zinc-200">Excise Tax Rates</h3>
        <button
          onClick={() => setCreating((c) => !c)}
          className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
        >
          {creating ? "Cancel" : "+ Add rate"}
        </button>
      </div>

      {creating && (
        <div className="flex items-end gap-2 mb-3 p-3 bg-zinc-900/60 border border-zinc-800 rounded">
          <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-40" />
          <input value={draftParty} onChange={(e) => setDraftParty(e.target.value)} placeholder="Receiving party"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-40" />
          <select value={draftUnit} onChange={(e) => setDraftUnit(e.target.value as "bbl" | "gallon")}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
            <option value="bbl">bbl</option>
            <option value="gallon">gallon</option>
          </select>
          <input value={draftRate} onChange={(e) => setDraftRate(e.target.value)} placeholder="Rate (USD)" type="number" step="0.01"
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 w-28" />
          <button onClick={create} className="text-xs px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors">
            Save
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Name</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Receiving Party</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Unit</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Rate</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <ExciseTaxRateRow key={rate.id} rate={rate} items={items} onSave={save} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" }) {
  return (
    <div className="flex flex-col gap-8">
      <ExciseTaxRatesSection />
      {scope === "full" && (
        <p className="text-xs text-zinc-600 italic">Service mappings + bulk discount sections added in Task 9.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx
git commit -m "feat: add ExportSettingsPanel with Excise Tax Rates CRUD section"
```

---

### Task 9: `ExportSettingsPanel` — Service Mappings + Bulk Discount sections

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx`

**Interfaces:**
- Consumes: `useExportServiceMappingsQuery`, `useContractPartnersQuery`, `usePackagingQuery` (existing hooks), `SquareDiscountSelect` (Task 7), `ExportServiceMapping`/`ServiceType` types (Task 6).
- Produces: replaces the placeholder paragraph from Task 8 with two real sections, only rendered when `scope === "full"`.

- [ ] **Step 1: Add the Service Mappings section**

Insert after the `ExciseTaxRatesSection` function and before `ExportSettingsPanel`:

```typescript
import { useContractPartnersQuery, usePackagingQuery, useExportServiceMappingsQuery } from "../hooks/queries";
import { SquareDiscountSelect } from "@/app/components/SquareCatalogSelect";
import type { ServiceType, ExportServiceMapping } from "../types";

const PACKAGING_SERVICE_LABELS: Record<"keg_cleaning" | "forklift", string> = {
  keg_cleaning: "Keg Cleaning",
  forklift: "Forklift",
};

function ServiceMappingRow({
  mapping,
  items,
  partnerLabel,
  onSave,
}: {
  mapping: ExportServiceMapping;
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  partnerLabel: string;
  onSave: (mapping: ExportServiceMapping, patch: Partial<ExportServiceMapping>) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function update(patch: Partial<ExportServiceMapping>) {
    setSaving(true);
    await onSave(mapping, patch);
    setSaving(false);
  }

  return (
    <tr className="border-b border-zinc-800 last:border-0">
      <td className="px-4 py-2.5 text-zinc-300">{partnerLabel}</td>
      <td className="px-4 py-2.5 text-zinc-400">{mapping.display_name}</td>
      <td className="px-4 py-2.5">
        <SquareCatalogSelect
          items={items}
          itemId={mapping.square_catalog_item_id}
          variationId={mapping.square_catalog_variation_id}
          onChange={(itemId, variationId) =>
            update({ square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
          }
        />
      </td>
      <td className="px-4 py-2.5 text-zinc-600">{saving ? "Saving…" : ""}</td>
    </tr>
  );
}

function PackagingFeeSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");

  async function upsert(existing: ExportServiceMapping | null, patch: Partial<ExportServiceMapping> & { packaging_item_id: string; partner_id: string | null }) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "packaging_fee",
        partner_id: patch.partner_id,
        packaging_item_id: patch.packaging_item_id,
        display_name: existing?.display_name ?? "Packaging Fee",
        square_catalog_item_id: patch.square_catalog_item_id ?? existing?.square_catalog_item_id ?? null,
        square_catalog_variation_id: patch.square_catalog_variation_id ?? existing?.square_catalog_variation_id ?? null,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Packaging Fee</h4>
      <p className="text-xs text-zinc-600 mb-2">Default mapping per packaging item, with optional per-partner overrides.</p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500" />
            </tr>
          </thead>
          <tbody>
            {packagingItems.map((pkg) => {
              const defaultRow = feeRows.find((m) => m.packaging_item_id === pkg.id && m.partner_id === null);
              return (
                <tr key={pkg.id} className="border-b border-zinc-800 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-500 italic">Default</td>
                  <td className="px-4 py-2.5 text-zinc-300">{pkg.name}</td>
                  <td className="px-4 py-2.5">
                    <SquareCatalogSelect
                      items={items}
                      itemId={defaultRow?.square_catalog_item_id ?? null}
                      variationId={defaultRow?.square_catalog_variation_id ?? null}
                      onChange={(itemId, variationId) =>
                        upsert(defaultRow ?? null, { partner_id: null, packaging_item_id: pkg.id, square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
                      }
                    />
                  </td>
                  <td />
                </tr>
              );
            })}
            {feeRows.filter((m) => m.partner_id !== null).map((m) => {
              const partner = partners.find((p) => p.id === m.partner_id);
              return (
                <ServiceMappingRow
                  key={m.id}
                  mapping={m}
                  items={items}
                  partnerLabel={partner?.company_name ?? "Unknown partner"}
                  onSave={(existing, patch) => upsert(existing, { partner_id: existing.partner_id, packaging_item_id: existing.packaging_item_id!, ...patch })}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SimpleServiceSection({ serviceType }: { serviceType: "keg_cleaning" | "forklift" }) {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const row = mappings.find((m) => m.service_type === serviceType && m.partner_id === null) ?? null;

  async function upsert(itemId: string | null, variationId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row?.id,
        service_type: serviceType,
        partner_id: null,
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
      <SquareCatalogSelect
        items={items}
        itemId={row?.square_catalog_item_id ?? null}
        variationId={row?.square_catalog_variation_id ?? null}
        onChange={upsert}
      />
    </section>
  );
}

function BulkDiscountSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const discounts = catalog?.discounts ?? [];

  const row = mappings.find((m) => m.service_type === "bulk_discount" && m.partner_id === null) ?? null;

  async function upsert(discountId: string | null) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row?.id,
        service_type: "bulk_discount",
        partner_id: null,
        display_name: "Bulk Discount",
        square_catalog_discount_id: discountId,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-zinc-200 mb-2">Bulk Discount</h3>
      <SquareDiscountSelect discounts={discounts} value={row?.square_catalog_discount_id ?? null} onChange={upsert} />
    </section>
  );
}
```

- [ ] **Step 2: Wire the new sections into the panel**

Replace the placeholder in `ExportSettingsPanel`:

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
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: build succeeds — confirms all imports resolve and prop types line up (`ExportServiceMapping.partner_id`/`packaging_item_id` nullability matches usage).

- [ ] **Step 4: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx
git commit -m "feat: add Service Mappings and Bulk Discount sections to ExportSettingsPanel"
```

---

### Task 10: Wire `ExportSettingsPanel` into Production > Export and Finance > Settings

**Files:**
- Modify: `app/production/components/ExportTab.tsx`
- Modify: `app/finance/settings/SettingsNav.tsx`
- Create: `app/finance/settings/excise-tax/page.tsx`

**Interfaces:**
- Consumes: `ExportSettingsPanel` (Tasks 8–9).

- [ ] **Step 1: Add a "Settings" tab to `ExportTab.tsx`**

In `app/production/components/ExportTab.tsx`, update the import block (line 9) and the `TopTab`/`TOP_TABS` definitions (lines 33–40):

```typescript
import ExportBayTab from "./ExportBayTab";
import ExportSettingsPanel from "./ExportSettingsPanel";
```

```typescript
type TopTab = "export_bay" | ExportChannel | "settings";

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "taproom", label: "Taproom" },
  { key: "distribution", label: "Distribution" },
  { key: "contract_brewing", label: "Contract Brewing" },
  { key: "settings", label: "Settings" },
];
```

Update the tab-bar's count badge guard (line 232, `key !== "export_bay"`) so `"settings"` doesn't also try to render an export count:

```typescript
            {key !== "export_bay" && key !== "settings" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
```

Update the render block at the bottom (lines 241–251) to add the settings branch:

```typescript
      {tab === "export_bay" && <ExportBayTab />}
      {tab === "settings" && <ExportSettingsPanel scope="full" />}
      {(tab === "taproom" || tab === "distribution" || tab === "contract_brewing") && (
        <ExportsChannelTab
          key={tab}
          channel={tab}
          exports={exports}
          links={links}
          recipes={recipes}
          onLinksChanged={() => {}}
        />
      )}
```

- [ ] **Step 2: Add the Finance > Settings > Excise Tax sub-tab**

In `app/finance/settings/SettingsNav.tsx`, update `SUBTABS`:

```typescript
const SUBTABS = [
  { href: "/finance/settings/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/finance/settings/account-mapping",   label: "Account Mapping"   },
  { href: "/finance/settings/excise-tax",        label: "Excise Tax"       },
  { href: "/finance/settings/import",            label: "Import"            },
];
```

- [ ] **Step 3: Create the Finance excise-tax page**

```typescript
// app/finance/settings/excise-tax/page.tsx
"use client";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ExciseTaxSettingsPage() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <SettingsNav />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800">
        <h1 className="text-base font-semibold text-zinc-100">Excise Tax</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Barrel excise tax rates and their Square line-item mappings.</p>
      </div>
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <ExportSettingsPanel scope="excise-only" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds, no missing-route or type errors.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/ExportTab.tsx app/finance/settings/SettingsNav.tsx app/finance/settings/excise-tax/page.tsx
git commit -m "feat: wire ExportSettingsPanel into Production > Export and Finance > Settings"
```

---

### Task 11: Apply the migration and verify against the live database

Per Lesson #2, this step requires the user.

- [ ] **Step 1: Ask the user to paste the migration into the Supabase Dashboard SQL Editor**

Provide the user the full contents of `supabase/migrations/20260624_export_settings.sql` (Task 1) and ask them to run it in the SQL Editor for project `drlsazatrcrdwaihjmex`, then confirm success.

- [ ] **Step 2: Ask the user to run the tracking insert**

```sql
insert into supabase_migrations.schema_migrations (version) values ('20260624') on conflict (version) do nothing;
```

- [ ] **Step 3: Independently verify via REST**

Run (using `.env.local`'s `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL`):

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/excise_tax_rates?select=id,name,square_catalog_item_id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Expected: 200 response with `square_catalog_item_id` present in the returned JSON (confirms the column exists), and a second check:

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/export_service_mappings?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Expected: 200 with `[]` (table exists, empty).

- [ ] **Step 4: No commit needed**

This task only applies SQL to the live database; the migration file itself was already committed in Task 1.

---

## Self-Review Notes

- **Spec coverage:** Data Model §1–2 → Task 1. UI §"Settings tab" → Task 10. UI §"Excise Tax sub-tab" → Task 10. `SquareCatalogSelect` → Task 7 (discount picker included as `SquareDiscountSelect`, addressing the spec's explicitly-flagged open question — resolved here via `types: "DISCOUNT"` on the existing `squareGetAll("/catalog/list", ...)` call, the same mechanism already used for `ITEM`/`CATEGORY`/`TAX`). Role gating → every route in Tasks 3–5 uses `requireRole(["brewer"])` for writes / `requireRole(["viewer"])` for reads. API Routes section → Tasks 3, 4, 5 exactly match the three listed endpoints (collapsing GET/POST/PATCH/DELETE into list+create / id-scoped edit+delete files, consistent with this repo's existing route-per-resource convention).
- **Placeholder scan:** none found — every step has complete code; Task 8's intentional placeholder paragraph is explicitly replaced by name in Task 9 Step 2, not left dangling.
- **Type consistency:** `ExciseTaxRate`/`ExportServiceMapping`/`ServiceType`/`SquareCatalogOptions` defined once in Task 6 and referenced identically (field names and nullability) through Tasks 7–10. `SquareCatalogSelect`'s `onChange(itemId, variationId)` signature is consistent everywhere it's called (Tasks 8 and 9).
