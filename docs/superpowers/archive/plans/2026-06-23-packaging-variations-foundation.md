# Packaging Variations Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a "packaging variation" (container + format + specific lid/paktech/tray/label components + optional partner exclusivity) definable as a first-class, reusable entity, and let recipes declare which variations they're packaged as — without changing any existing consumer of `packaging_items`.

**Architecture:** One new table, `packaging_variations`, with four nullable component-slot FK columns (no junction table — a variation never uses more than one component per category). One new join table, `recipe_packaging_variations`, mirroring the existing `recipe_square_links` pattern. `packaging_items.type` gets a `CHECK` constraint tightened onto it (still `text`, not a native `enum`, per this codebase's convention for evolvable categorical columns). A new definition UI (CRUD on variations) lives inside `PackagingTab.tsx` as a second sub-view; a new per-recipe linking UI lives inside `RecipesTab.tsx`'s existing expanded-recipe-card layout.

**Tech Stack:** Next.js App Router route handlers, Supabase Postgres (manual dashboard-applied migrations per this repo's Lesson #2), React Query, Tailwind.

## Global Constraints

- No test runner exists in this repo. Verification is `npm run lint` + `npm run build` + a direct REST check via `curl` against the live Supabase project (`drlsazatrcrdwaihjmex`) using `.env.local`'s `SUPABASE_SERVICE_ROLE_KEY`, per this project's Lesson #1.
- Migrations are never applied by the agent directly — paste the SQL into the Supabase Dashboard SQL editor yourself, get the user to run it and confirm, then separately insert the tracking row into `supabase_migrations.schema_migrations`, per Lesson #2. **Never run `supabase migration repair --status reverted`.**
- This spec does not touch any existing consumer of `packaging_items` (`transfers/route.ts`, `ExportSettingsPanel.tsx`, `demand-calendar/route.ts`, etc.) — those are explicitly out of scope, deferred to Specs 10/11/8. Do not "helpfully" wire them up while in here.
- Follow `requireRole` as a literal allow-list, not a floor (this codebase's Lesson from Spec 7-pre) — GET routes in this domain do not call `requireRole` at all (see `packaging/route.ts` GET, `recipe-square-links/route.ts` GET); write routes (`POST`/`PATCH`/`DELETE`) use `requireRole(["brewer"])`, matching the existing `packaging/route.ts` and `packaging/[id]/route.ts` convention exactly.
- New table/column names, migration file naming, and code style must match the patterns already in `supabase/migrations/20260619_commitment_packaging_preferences.sql` and `app/api/production/recipe-square-links/route.ts` — read those before writing new code if anything below is ambiguous.

---

### Task 1: Migration — `packaging_variations`, `recipe_packaging_variations`, tighten `packaging_items.type`

**Files:**
- Create: `supabase/migrations/20260626_packaging_variations.sql`

**Interfaces:**
- Produces: tables `packaging_variations` (columns: `id`, `container_id`, `format`, `lid_id`, `paktech_id`, `tray_id`, `label_id`, `partner_id`, `name`, `is_active`, `created_at`) and `recipe_packaging_variations` (columns: `id`, `recipe_id`, `variation_id`, `created_at`), consumed by Tasks 2-7.

- [ ] **Step 1: Write the migration file**

```sql
-- Packaging Variations foundation (Spec 9). Lets a strictly-defined
-- combination of container + format + components be named and reused,
-- instead of re-assembled ad hoc on every kegging/canning transfer with
-- no persisted record of what the combination actually was. Wiring this
-- into transfers/cold storage/export/deposit flows is deferred to
-- follow-on specs (10, 11, 8) — this migration only adds the entity.

-- Tighten packaging_items.type from unconstrained text to a checked set.
-- Kept as text + CHECK (not a native enum) per this codebase's convention
-- for categorical columns expected to gain values over time (see status,
-- channel, service_type, unit columns elsewhere in this schema).
alter table public.packaging_items
  add constraint packaging_items_type_check
  check (type in ('keg', 'can', 'lid', 'paktech', 'tray', 'label'));

create table public.packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  container_id  uuid        not null references public.packaging_items(id) on delete restrict,
  format        text        not null check (format in ('loose', '4-pack', '6-pack', 'case')),
  lid_id        uuid        references public.packaging_items(id) on delete restrict,
  paktech_id    uuid        references public.packaging_items(id) on delete restrict,
  tray_id       uuid        references public.packaging_items(id) on delete restrict,
  label_id      uuid        references public.packaging_items(id) on delete restrict,
  partner_id    uuid        references public.contract_brewing_partners(id) on delete set null,
  name          text        not null,
  is_active     bool        not null default true,
  created_at    timestamptz not null default now()
);

create index packaging_variations_container_idx on public.packaging_variations(container_id);
create index packaging_variations_partner_idx on public.packaging_variations(partner_id);

create table public.recipe_packaging_variations (
  id            uuid        primary key default gen_random_uuid(),
  recipe_id     uuid        not null references public.recipes(id) on delete cascade,
  variation_id  uuid        not null references public.packaging_variations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (recipe_id, variation_id)
);

create index recipe_packaging_variations_recipe_idx on public.recipe_packaging_variations(recipe_id);

-- Seed the 11 generic (partner_id null) variations named during brainstorming.
-- container_id values are looked up by name since this repo has no seeded
-- packaging_items rows with stable ids — these names match the live data
-- confirmed during Spec 9's brainstorm (1/2 Keg, 1/4 Keg, 1/6 Keg, 12oz Blank,
-- 16oz Blank). Component slots (lid/paktech/tray/label) are left null in
-- this seed since assigning a specific live component to each pack/case
-- format is a real product decision, not something to default silently —
-- the user fills those in via the new UI once it exists.
insert into public.packaging_variations (container_id, format, name)
select id, 'loose', name
from public.packaging_items
where type = 'keg' and name in ('1/2 Keg', '1/4 Keg', '1/6 Keg');

insert into public.packaging_variations (container_id, format, name)
select id, 'loose', name
from public.packaging_items
where type = 'can' and name in ('12oz Blank', '16oz Blank');

insert into public.packaging_variations (container_id, format, name)
select id, v.format, concat(p.name, ' ', v.label)
from public.packaging_items p
cross join (values ('4-pack', '4-Pack'), ('6-pack', '6-Pack'), ('case', 'Case')) as v(format, label)
where p.type = 'can' and p.name in ('12oz Blank', '16oz Blank');
```

- [ ] **Step 2: Ask the user to paste this into the Supabase Dashboard SQL editor for project `drlsazatrcrdwaihjmex` and confirm it ran without error.**

Per Lesson #2, the agent never runs migrations directly. Wait for explicit user confirmation before proceeding to Step 3.

- [ ] **Step 3: Record the migration as tracked, once the user confirms it ran**

Ask the user to also run (or run it yourself via the Supabase MCP/REST if available — this part is just bookkeeping, not schema-changing):

```sql
insert into supabase_migrations.schema_migrations (version)
values ('20260626')
on conflict (version) do nothing;
```

- [ ] **Step 4: Verify via direct REST check**

```bash
set -a; source .env.local; set +a
curl -s "${SUPABASE_URL}/rest/v1/packaging_variations?select=id,name,format,container_id&order=name" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" | python3 -m json.tool
```

Expected: 11 rows (1/2 Keg, 1/4 Keg, 1/6 Keg, 12oz Blank, 16oz Blank, 12oz Blank 4-Pack, 12oz Blank 6-Pack, 12oz Blank Case, 16oz Blank 4-Pack, 16oz Blank 6-Pack, 16oz Blank Case).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260626_packaging_variations.sql
git commit -m "feat: add packaging_variations + recipe_packaging_variations tables"
```

---

### Task 2: Types

**Files:**
- Modify: `app/production/types.ts` (add after the existing `PackagingItem` interface, currently ending around line 47)

**Interfaces:**
- Consumes: `PackagingItem`, `PackagingItemType` (already defined in this file)
- Produces: `PackagingVariationFormat`, `PackagingVariation`, `RecipePackagingVariation` — consumed by Tasks 3, 4, 5, 6, 7.

- [ ] **Step 1: Add the new types**

Insert immediately after the closing brace of the existing `PackagingItem` interface:

```typescript
export type PackagingVariationFormat = "loose" | "4-pack" | "6-pack" | "case";

export interface PackagingVariation {
  id: string;
  container_id: string;
  format: PackagingVariationFormat;
  lid_id: string | null;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  name: string;
  is_active: boolean;
  created_at: string;
  /** Joined */
  container?: { id: string; name: string; type: PackagingItemType; volume_fl_oz: number | null } | null;
  lid?: { id: string; name: string } | null;
  paktech?: { id: string; name: string } | null;
  tray?: { id: string; name: string } | null;
  label?: { id: string; name: string } | null;
  contract_brewing_partners?: { company_name: string } | null;
}

export interface RecipePackagingVariation {
  id: string;
  recipe_id: string;
  variation_id: string;
  created_at: string;
  /** Joined */
  packaging_variations?: PackagingVariation | null;
}
```

- [ ] **Step 2: Verify the file still compiles in isolation**

Run: `npx tsc --noEmit -p . 2>&1 | grep -i "types.ts" || echo "no errors in types.ts"`
Expected: `no errors in types.ts`

- [ ] **Step 3: Commit**

```bash
git add app/production/types.ts
git commit -m "feat: add PackagingVariation and RecipePackagingVariation types"
```

---

### Task 3: API routes — `packaging-variations`

**Files:**
- Create: `app/api/production/packaging-variations/route.ts`
- Create: `app/api/production/packaging-variations/[id]/route.ts`

**Interfaces:**
- Consumes: `requireRole` from `@/lib/auth`, `createSupabaseServerClient` from `@/lib/supabase/server`
- Produces: `GET /api/production/packaging-variations` → `PackagingVariation[]`; `POST` → created row; `PATCH /api/production/packaging-variations/[id]` → updated row; `DELETE` → 204. Consumed by Task 5's query hooks.

- [ ] **Step 1: Write `app/api/production/packaging-variations/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT = `
  *,
  container:packaging_items!packaging_variations_container_id_fkey(id, name, type, volume_fl_oz),
  lid:packaging_items!packaging_variations_lid_id_fkey(id, name),
  paktech:packaging_items!packaging_variations_paktech_id_fkey(id, name),
  tray:packaging_items!packaging_variations_tray_id_fkey(id, name),
  label:packaging_items!packaging_variations_label_id_fkey(id, name),
  contract_brewing_partners(company_name)
`;

function validateFormat(format: string, paktech_id: string | null, tray_id: string | null): string | null {
  if (format === "4-pack" || format === "6-pack") {
    if (!paktech_id) return `format "${format}" requires paktech_id`;
    if (tray_id) return `format "${format}" must not have tray_id`;
  }
  if (format === "case") {
    if (!tray_id) return `format "case" requires tray_id`;
    if (paktech_id) return `format "case" must not have paktech_id`;
  }
  if (format === "loose" && (paktech_id || tray_id)) {
    return `format "loose" must not have paktech_id or tray_id`;
  }
  return null;
}

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("packaging_variations")
    .select(SELECT)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const { container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id, name } = body;

  if (!container_id || !format || !name) {
    return NextResponse.json({ error: "container_id, format, and name are required" }, { status: 400 });
  }

  const formatError = validateFormat(format, paktech_id || null, tray_id || null);
  if (formatError) return NextResponse.json({ error: formatError }, { status: 400 });

  const { data: container } = await supabase
    .from("packaging_items")
    .select("type")
    .eq("id", container_id)
    .single();
  if (!container || (container.type !== "keg" && container.type !== "can")) {
    return NextResponse.json({ error: "container_id must reference a packaging_items row of type keg or can" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("packaging_variations")
    .insert({
      container_id,
      format,
      lid_id: lid_id || null,
      paktech_id: paktech_id || null,
      tray_id: tray_id || null,
      label_id: label_id || null,
      partner_id: partner_id || null,
      name,
    })
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 2: Write `app/api/production/packaging-variations/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT = `
  *,
  container:packaging_items!packaging_variations_container_id_fkey(id, name, type, volume_fl_oz),
  lid:packaging_items!packaging_variations_lid_id_fkey(id, name),
  paktech:packaging_items!packaging_variations_paktech_id_fkey(id, name),
  tray:packaging_items!packaging_variations_tray_id_fkey(id, name),
  label:packaging_items!packaging_variations_label_id_fkey(id, name),
  contract_brewing_partners(company_name)
`;

function validateFormat(format: string, paktech_id: string | null, tray_id: string | null): string | null {
  if (format === "4-pack" || format === "6-pack") {
    if (!paktech_id) return `format "${format}" requires paktech_id`;
    if (tray_id) return `format "${format}" must not have tray_id`;
  }
  if (format === "case") {
    if (!tray_id) return `format "case" requires tray_id`;
    if (paktech_id) return `format "case" must not have paktech_id`;
  }
  if (format === "loose" && (paktech_id || tray_id)) {
    return `format "loose" must not have paktech_id or tray_id`;
  }
  return null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();
  const { container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id, name, is_active } = body;

  if (!container_id || !format || !name) {
    return NextResponse.json({ error: "container_id, format, and name are required" }, { status: 400 });
  }

  const formatError = validateFormat(format, paktech_id || null, tray_id || null);
  if (formatError) return NextResponse.json({ error: formatError }, { status: 400 });

  const { data, error } = await supabase
    .from("packaging_variations")
    .update({
      container_id,
      format,
      lid_id: lid_id || null,
      paktech_id: paktech_id || null,
      tray_id: tray_id || null,
      label_id: label_id || null,
      partner_id: partner_id || null,
      name,
      is_active: is_active ?? true,
    })
    .eq("id", id)
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const { error } = await supabase.from("packaging_variations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Verify the foreign-key constraint names used in `SELECT` match what Postgres actually generated**

Supabase's PostgREST embedding syntax (`table!constraint_name(...)`) requires the exact FK constraint name. Run:

```bash
set -a; source .env.local; set +a
curl -s "${SUPABASE_URL}/rest/v1/packaging_variations?select=id,container:packaging_items!packaging_variations_container_id_fkey(name)&limit=1" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Expected: a JSON array (possibly empty `[]` if no rows match yet, but importantly **not** a PostgREST error about an unknown relationship/constraint). If it errors, query the real constraint name and fix every `SELECT` constant above:

```sql
select conname from pg_constraint where conrelid = 'public.packaging_variations'::regclass and contype = 'f';
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: clean build, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/packaging-variations
git commit -m "feat: add packaging-variations CRUD API routes"
```

---

### Task 4: API routes — `recipe-packaging-variations`

**Files:**
- Create: `app/api/production/recipe-packaging-variations/route.ts`

**Interfaces:**
- Produces: `GET /api/production/recipe-packaging-variations` → `RecipePackagingVariation[]`; `POST` → created link; `DELETE?id=` → 204. Consumed by Task 5's query hooks and Task 7's UI. Mirrors `app/api/production/recipe-square-links/route.ts`'s exact shape (GET/POST/DELETE in one file, no `[id]` route).

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select("*, packaging_variations(*)")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { recipe_id, variation_id } = await req.json();
  if (!recipe_id || !variation_id) {
    return NextResponse.json({ error: "recipe_id and variation_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .insert({ recipe_id, variation_id })
    .select("*, packaging_variations(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_packaging_variations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/recipe-packaging-variations
git commit -m "feat: add recipe-packaging-variations link API route"
```

---

### Task 5: Query hooks

**Files:**
- Modify: `lib/query-keys.ts` (add two keys inside `production`, after the existing `recipeSquareLinks` line)
- Modify: `app/production/hooks/queries.ts` (add two hooks after `usePackagingQuery`, plus extend the `productionKeys` alias object)

**Interfaces:**
- Consumes: `PackagingVariation`, `RecipePackagingVariation` from `../types` (Task 2); `fetchJson` (already in this file)
- Produces: `usePackagingVariationsQuery()`, `useRecipePackagingVariationsQuery()`, `productionKeys.packagingVariations`, `productionKeys.recipePackagingVariations` — consumed by Tasks 6 and 7.

- [ ] **Step 1: Add query keys**

In `lib/query-keys.ts`, immediately after the line `recipeSquareLinks:    () => ["production", "recipe-square-links"] as const,`:

```typescript
    packagingVariations:  () => ["production", "packaging-variations"] as const,
    recipePackagingVariations: () => ["production", "recipe-packaging-variations"] as const,
```

- [ ] **Step 2: Add hooks**

In `app/production/hooks/queries.ts`, update the import line to add the two new types:

```typescript
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier, ExciseTaxRate, ExportServiceMapping, SquareCatalogOptions,
  PackagingVariation, RecipePackagingVariation,
} from "../types";
```

Add to the `productionKeys` alias object, after the `packaging:` line:

```typescript
  packagingVariations:       queryKeys.production.packagingVariations(),
  recipePackagingVariations: queryKeys.production.recipePackagingVariations(),
```

Add new hooks immediately after `usePackagingQuery`:

```typescript
export function usePackagingVariationsQuery() {
  return useQuery({
    queryKey: productionKeys.packagingVariations,
    queryFn: () => fetchJson<PackagingVariation[]>("/api/production/packaging-variations"),
  });
}

export function useRecipePackagingVariationsQuery() {
  return useQuery({
    queryKey: productionKeys.recipePackagingVariations,
    queryFn: () => fetchJson<RecipePackagingVariation[]>("/api/production/recipe-packaging-variations"),
  });
}
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add lib/query-keys.ts app/production/hooks/queries.ts
git commit -m "feat: add query hooks for packaging variations"
```

---

### Task 6: Definition UI — variations sub-view in `PackagingTab.tsx`

**Files:**
- Create: `app/production/components/PackagingVariationsPanel.tsx`
- Modify: `app/production/components/PackagingTab.tsx` (add a two-way toggle at the top, render this panel when selected)

**Interfaces:**
- Consumes: `usePackagingQuery`, `usePackagingVariationsQuery`, `useContractPartnersQuery`, `productionKeys` (from `../hooks/queries`); `Modal`, `Field`, `ModalActions` (from `./shared`); `PackagingVariation`, `PackagingVariationFormat`, `PackagingItem` (from `../types`)
- Produces: default export `PackagingVariationsPanel` — a self-contained list + create/edit modal, no props. Consumed by Task 6 Step 3 (the `PackagingTab.tsx` toggle).

- [ ] **Step 1: Write `app/production/components/PackagingVariationsPanel.tsx`**

```tsx
"use client";

import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PackagingVariation, PackagingVariationFormat } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { usePackagingQuery, usePackagingVariationsQuery, useContractPartnersQuery, productionKeys } from "../hooks/queries";

const FORMATS: { value: PackagingVariationFormat; label: string }[] = [
  { value: "loose",   label: "Loose" },
  { value: "4-pack",  label: "4-Pack" },
  { value: "6-pack",  label: "6-Pack" },
  { value: "case",    label: "Case" },
];

function needsPaktech(format: PackagingVariationFormat) { return format === "4-pack" || format === "6-pack"; }
function needsTray(format: PackagingVariationFormat)     { return format === "case"; }

const EMPTY_FORM = {
  container_id: "",
  format: "loose" as PackagingVariationFormat,
  lid_id: "",
  paktech_id: "",
  tray_id: "",
  label_id: "",
  partner_id: "",
  name: "",
};

type FormState = typeof EMPTY_FORM;

export default function PackagingVariationsPanel() {
  const qc = useQueryClient();
  const { data: packaging = [] } = usePackagingQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const onRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.packagingVariations });

  const containers = packaging.filter((p) => p.type === "keg" || p.type === "can");
  const lids       = packaging.filter((p) => p.type === "lid");
  const paktechs    = packaging.filter((p) => p.type === "paktech");
  const trays       = packaging.filter((p) => p.type === "tray");
  const labels      = packaging.filter((p) => p.type === "label");

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openNew() { setForm(EMPTY_FORM); setEditingId(null); setError(null); setShowModal(true); }

  function openEdit(v: PackagingVariation) {
    setForm({
      container_id: v.container_id,
      format: v.format,
      lid_id: v.lid_id ?? "",
      paktech_id: v.paktech_id ?? "",
      tray_id: v.tray_id ?? "",
      label_id: v.label_id ?? "",
      partner_id: v.partner_id ?? "",
      name: v.name,
    });
    setEditingId(v.id);
    setError(null);
    setShowModal(true);
  }

  function updateForm(patch: Partial<FormState>) {
    setForm((f) => {
      const next = { ...f, ...patch };
      if (patch.format) {
        if (!needsPaktech(patch.format)) next.paktech_id = "";
        if (!needsTray(patch.format)) next.tray_id = "";
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        container_id: form.container_id,
        format: form.format,
        lid_id: form.lid_id || null,
        paktech_id: form.paktech_id || null,
        tray_id: form.tray_id || null,
        label_id: form.label_id || null,
        partner_id: form.partner_id || null,
        name: form.name,
      };
      const res = editingId
        ? await fetch(`/api/production/packaging-variations/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/packaging-variations",               { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      await onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(v: PackagingVariation) {
    if (!confirm(`Delete "${v.name}"?`)) return;
    await fetch(`/api/production/packaging-variations/${v.id}`, { method: "DELETE" });
    await onRefresh();
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-4">
        <p className="text-xs text-zinc-500">
          Strictly-defined packaging combinations — container + format + specific components. Used by Recipes to declare which variations they're packaged as.
        </p>
        <button onClick={openNew} className="btn-amber shrink-0">+ Add Variation</button>
      </div>

      {variations.length === 0 ? (
        <p className="text-zinc-600 text-sm">No packaging variations yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Name</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Container</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Format</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Components</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500"></th>
              </tr>
            </thead>
            <tbody>
              {variations.map((v, i) => (
                <tr key={v.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-3 py-2.5 text-zinc-200 font-medium">{v.name}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{v.container?.name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{FORMATS.find((f) => f.value === v.format)?.label ?? v.format}</td>
                  <td className="px-3 py-2.5 text-zinc-400 text-xs">
                    {[v.lid?.name, v.paktech?.name, v.tray?.name, v.label?.name].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-400">{v.contract_brewing_partners?.company_name ?? "Generic"}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(v)} className="text-xs text-zinc-400 hover:text-zinc-200 mr-3">Edit</button>
                    <button onClick={() => handleDelete(v)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Variation" : "New Variation"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            <Field label="Name" required>
              <input className="inp w-full" value={form.name} onChange={(e) => updateForm({ name: e.target.value })} required />
            </Field>
            <Field label="Container" required>
              <select className="inp w-full" value={form.container_id} onChange={(e) => updateForm({ container_id: e.target.value })} required>
                <option value="">Select…</option>
                {containers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Format" required>
              <select className="inp w-full" value={form.format} onChange={(e) => updateForm({ format: e.target.value as PackagingVariationFormat })}>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Lid">
              <select className="inp w-full" value={form.lid_id} onChange={(e) => updateForm({ lid_id: e.target.value })}>
                <option value="">None</option>
                {lids.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            {needsPaktech(form.format) && (
              <Field label="PakTech" required>
                <select className="inp w-full" value={form.paktech_id} onChange={(e) => updateForm({ paktech_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {paktechs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
            {needsTray(form.format) && (
              <Field label="Tray" required>
                <select className="inp w-full" value={form.tray_id} onChange={(e) => updateForm({ tray_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {trays.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Label">
              <select className="inp w-full" value={form.label_id} onChange={(e) => updateForm({ label_id: e.target.value })}>
                <option value="">None</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Partner" hint="Leave blank for a generic variation available to everyone">
              <select className="inp w-full" value={form.partner_id} onChange={(e) => updateForm({ partner_id: e.target.value })}>
                <option value="">Generic (no partner)</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
              </select>
            </Field>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)} label={editingId ? "Save" : "Create"} />
          </form>
        </Modal>
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify component-vs-format mismatch is rejected server-side**

This is a manual smoke test, not an automated one (no test runner in this repo). After Task 3 and this step are both done and the dev server is running:

```bash
curl -s -X POST http://localhost:3000/api/production/packaging-variations \
  -H "Content-Type: application/json" \
  -d '{"container_id":"<a real can id>","format":"case","name":"Bad Test"}'
```

Expected: `400` with `{"error":"format \"case\" requires tray_id"}`. Delete nothing — this request should fail before insert.

- [ ] **Step 3: Add the sub-view toggle to `PackagingTab.tsx`**

In `app/production/components/PackagingTab.tsx`, add the import:

```typescript
import PackagingVariationsPanel from "./PackagingVariationsPanel";
```

Add a `view` state right after the existing `filterType` state declaration (`const [filterType, setFilterType] = useState<PackagingItemType | "all">("all");`):

```typescript
  const [view, setView] = useState<"items" | "variations">("items");
```

Wrap the existing top-of-component filter-pills block and the `{packaging.length === 0 ? ... }` block in a conditional, and add the toggle above both. Change the return statement's opening:

```tsx
  return (
    <>
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setView("items")}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${view === "items" ? "border-zinc-500 text-zinc-200 bg-zinc-800" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
        >
          Items
        </button>
        <button
          onClick={() => setView("variations")}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${view === "variations" ? "border-zinc-500 text-zinc-200 bg-zinc-800" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
        >
          Variations
        </button>
      </div>

      {view === "variations" ? (
        <PackagingVariationsPanel />
      ) : (
        <>
```

Then close that new `<>` fragment right before the component's existing final closing tags. Concretely: find the existing top-level `return ( <> ... </> )` in `PackagingTab.tsx` and:
1. Insert the toggle + `{view === "variations" ? <PackagingVariationsPanel /> : (<>` immediately after the opening `<>`.
2. Insert `</>)}` immediately before the final closing `</>` (after the existing modals — the "Add Item" modal and the adjustment modal — so both still render only in "items" view, which is correct since they only operate on `packaging_items`).

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/PackagingVariationsPanel.tsx app/production/components/PackagingTab.tsx
git commit -m "feat: add packaging variations definition UI"
```

---

### Task 7: Recipe-linking UI in `RecipesTab.tsx`

**Files:**
- Modify: `app/production/components/RecipesTab.tsx`

**Interfaces:**
- Consumes: `usePackagingVariationsQuery`, `useRecipePackagingVariationsQuery`, `productionKeys` (from `../hooks/queries`); `PackagingVariation`, `RecipePackagingVariation` (from `../types`)
- Produces: a new section inside each expanded recipe card listing/linking/unlinking `packaging_variations`. No new exports — purely additive UI inside the existing default-exported `RecipesTab`.

- [ ] **Step 1: Add imports and queries**

In `app/production/components/RecipesTab.tsx`, update the existing types import line to add `RecipePackagingVariation`:

```typescript
import { Recipe, RecipeBrewActivityTemplate, INGREDIENT_CATEGORIES, IngredientCategory, leadTimeDays, RecipePackagingVariation } from "../types";
```

And extend the existing hooks import line:

```typescript
import { useRecipesQuery, useIngredientsQuery, useContractPartnersQuery, productionKeys, fetchJson, usePackagingVariationsQuery, useRecipePackagingVariationsQuery } from "../hooks/queries";
```

Inside `RecipesTab()`, immediately after the existing `const { data: partners = [] } = useContractPartnersQuery();` line, add:

```typescript
  const { data: variations = [] } = usePackagingVariationsQuery();
  const { data: recipeLinks = [] } = useRecipePackagingVariationsQuery();
  const [linkingFor, setLinkingFor] = useState<string | null>(null);

  function variationsFor(recipeId: string): RecipePackagingVariation[] {
    return recipeLinks.filter((l) => l.recipe_id === recipeId);
  }

  async function linkVariation(recipeId: string, variationId: string) {
    if (!variationId) return;
    await fetch("/api/production/recipe-packaging-variations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipe_id: recipeId, variation_id: variationId }),
    });
    await qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations });
  }

  async function unlinkVariation(linkId: string) {
    await fetch(`/api/production/recipe-packaging-variations?id=${linkId}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations });
  }
```

- [ ] **Step 2: Add the section to the expanded recipe card**

In the expanded recipe card's JSX, insert a new section immediately before the existing `{/* Notes */}` block (which currently sits right before the `{/* Actions */}` block, per the file's current structure):

```tsx
                    {/* Packaging Variations */}
                    <div className="px-4 py-3 border-t border-zinc-800">
                      <p className="text-xs font-medium text-zinc-500 mb-2">Packaging Variations</p>
                      {variationsFor(r.id).length > 0 ? (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {variationsFor(r.id).map((link) => (
                            <span key={link.id} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-300">
                              {link.packaging_variations?.name ?? "—"}
                              <button onClick={() => unlinkVariation(link.id)} className="text-zinc-600 hover:text-red-400 leading-none">×</button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-600 mb-2">No packaging variations linked yet.</p>
                      )}
                      {linkingFor === r.id ? (
                        <select
                          className="inp text-xs"
                          autoFocus
                          defaultValue=""
                          onChange={(e) => { linkVariation(r.id, e.target.value); setLinkingFor(null); }}
                          onBlur={() => setLinkingFor(null)}
                        >
                          <option value="">Select a variation…</option>
                          {variations
                            .filter((v) => !variationsFor(r.id).some((l) => l.variation_id === v.id))
                            .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      ) : (
                        <button onClick={() => setLinkingFor(r.id)} className="text-xs text-amber-400 hover:text-amber-300">
                          + Link variation
                        </button>
                      )}
                    </div>
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: clean build, no type errors.

- [ ] **Step 4: Manual verification via REST**

```bash
set -a; source .env.local; set +a
curl -s "${SUPABASE_URL}/rest/v1/recipe_packaging_variations?select=*" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}"
```

Expected: `[]` (empty — no links created by this plan, the table just needs to exist and be queryable). Then, with the dev server running, open Production > Recipes, expand any recipe, click "+ Link variation," pick one of the 11 seeded variations, confirm it appears as a chip, then click its `×` to unlink and confirm it disappears. Re-run the same `curl` after linking to see the row appear.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/RecipesTab.tsx
git commit -m "feat: add recipe packaging variations linking UI"
```

---

## Final verification (after all tasks)

- [ ] `npm run lint` — expect 0 errors, 0 warnings in any file this plan touched.
- [ ] `npm run build` — expect a clean production build.
- [ ] Confirm no existing consumer of `packaging_items` was modified — `git diff main --stat` should show only the files listed in Tasks 1-7 above (new files plus `PackagingTab.tsx`, `RecipesTab.tsx`, `lib/query-keys.ts`, `app/production/hooks/queries.ts`, `app/production/types.ts`).
- [ ] Re-run the Task 1 Step 4 REST check to confirm the 11 seeded variations are still present and correctly shaped.
