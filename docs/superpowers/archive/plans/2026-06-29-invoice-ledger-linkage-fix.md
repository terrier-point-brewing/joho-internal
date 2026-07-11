# Invoice Ledger Linkage Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four bugs in how production invoice routes write into the `invoices` ledger: wrong `invoice_type` for export invoices, broken `'other'` source, missing `invoice_batch_links`, and wrong line item categories.

**Architecture:** Pure type/lib changes first (Tasks 1–2), then parallel route fixes (Tasks 3–5), then UI (Task 6), then migration (Task 7). The migration is applied last because it backfills existing data — route code changes are safe to deploy before the migration runs since the new enum values are additive.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Vitest

## Global Constraints

- Supabase admin client (`lib/supabase/admin`) in route handlers; never browser client
- All new DB values must match constraint values exactly (case-sensitive)
- No new tables or columns — only constraint extensions and backfills
- Migration file must use today's date prefix: `20260629`
- Run `npm run build` (no type errors) and `npm test` (all tests pass) before each commit

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `types/finance.ts` | Modify | Add `"export_invoice"` to `InvoiceType`; add `"ingredient_deposit"` to `InvoiceLineCategory` |
| `lib/finance/classify.ts` | Modify | Route `"ingredient deposit"` → `ingredient_deposit` instead of `materials_packaging` |
| `lib/finance/classify.test.ts` | Create | Vitest unit tests for `classifyLineItem` |
| `app/api/production/export/invoice/route.ts` | Modify | Fix type, source bug, add batch links in generate/record/mark_paid |
| `app/api/production/export/invoices/route.ts` | Modify | Change `invoice_type` filter from `"standard"` → `"export_invoice"` |
| `app/api/production/allocations/[id]/invoice/route.ts` | Modify | Fix deposit line item category; fix `mark_paid` source |
| `app/finance/invoices/page.tsx` | Modify | Add `"export_invoice"` option to type filter |
| `supabase/migrations/20260629_invoice_ledger_linkage_fix.sql` | Create | Extend constraints + 4 backfill statements |

---

## Task 1: Types — add `"export_invoice"` and `"ingredient_deposit"`

**Files:**
- Modify: `types/finance.ts`

**Interfaces:**
- Produces: `InvoiceType` with `"export_invoice"` value; `InvoiceLineCategory` with `"ingredient_deposit"` value — consumed by Tasks 2, 3, 5, 6

- [ ] **Step 1: Edit `types/finance.ts`**

Open `types/finance.ts`. Make two changes:

Change line 6:
```ts
// before
export type InvoiceType = "standard" | "allocation_deposit";
// after
export type InvoiceType = "standard" | "allocation_deposit" | "export_invoice";
```

Change lines 8–15 (the `InvoiceLineCategory` type):
```ts
// before
export type InvoiceLineCategory =
  | "materials_packaging"
  | "packaging_fees"
  | "other_services"
  | "pass_through_taxes"
  | "distribution_keg"
  | "distribution_can"
  | "other";
// after
export type InvoiceLineCategory =
  | "ingredient_deposit"
  | "materials_packaging"
  | "packaging_fees"
  | "other_services"
  | "pass_through_taxes"
  | "distribution_keg"
  | "distribution_can"
  | "other";
```

- [ ] **Step 2: Verify no build errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: build completes with no type errors (warnings about unused vars are acceptable).

- [ ] **Step 3: Commit**

```bash
git add types/finance.ts
git commit -m "feat(finance): add export_invoice type and ingredient_deposit line category"
```

---

## Task 2: classify.ts — split `ingredient_deposit` from `materials_packaging`

**Files:**
- Modify: `lib/finance/classify.ts`
- Create: `lib/finance/classify.test.ts`

**Interfaces:**
- Consumes: `InvoiceLineCategory` from Task 1 (specifically the new `"ingredient_deposit"` value)
- Produces: `classifyLineItem(name: string): InvoiceLineCategory` — used by `syncSquareInvoices.ts` and route handlers

- [ ] **Step 1: Write the failing test**

Create `lib/finance/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyLineItem, normalizeStatus } from "./classify";

describe("classifyLineItem", () => {
  it("routes ingredient deposit to ingredient_deposit", () => {
    expect(classifyLineItem("Ingredient Deposit")).toBe("ingredient_deposit");
    expect(classifyLineItem("ingredient deposit — some variant")).toBe("ingredient_deposit");
  });

  it("routes packaging material to materials_packaging", () => {
    expect(classifyLineItem("Packaging Material — 12oz Cans")).toBe("materials_packaging");
    expect(classifyLineItem("packaging material")).toBe("materials_packaging");
  });

  it("ingredient deposit does NOT return materials_packaging", () => {
    expect(classifyLineItem("Ingredient Deposit")).not.toBe("materials_packaging");
  });

  it("routes packaging fee to packaging_fees", () => {
    expect(classifyLineItem("Packaging Fee")).toBe("packaging_fees");
  });

  it("routes keg cleaning to other_services", () => {
    expect(classifyLineItem("Keg Cleaning")).toBe("other_services");
    expect(classifyLineItem("forklift service")).toBe("other_services");
    expect(classifyLineItem("CO2 Refill")).toBe("other_services");
    expect(classifyLineItem("Keg Transformation")).toBe("other_services");
  });

  it("routes barrel excise tax to pass_through_taxes", () => {
    expect(classifyLineItem("Barrel Excise Tax")).toBe("pass_through_taxes");
  });

  it("returns other for unknown items", () => {
    expect(classifyLineItem("Some Random Service")).toBe("other");
  });
});

describe("normalizeStatus", () => {
  it("maps paid variants", () => {
    expect(normalizeStatus("Paid")).toBe("paid");
    expect(normalizeStatus("closed")).toBe("paid");
  });

  it("maps open variants", () => {
    expect(normalizeStatus("open")).toBe("open");
    expect(normalizeStatus("UNPAID")).toBe("open");
  });

  it("maps voided", () => {
    expect(normalizeStatus("Voided")).toBe("voided");
  });

  it("defaults to unknown", () => {
    expect(normalizeStatus("???")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- lib/finance/classify.test.ts 2>&1 | tail -20
```

Expected: test `"routes ingredient deposit to ingredient_deposit"` FAILS with `expected 'materials_packaging' to be 'ingredient_deposit'`.

- [ ] **Step 3: Fix `classify.ts`**

In `lib/finance/classify.ts`, change the first branch of `classifyLineItem`:

```ts
// before
if (n.includes("ingredient deposit") || n.includes("packaging material")) return "materials_packaging";

// after
if (n.includes("ingredient deposit")) return "ingredient_deposit";
if (n.includes("packaging material")) return "materials_packaging";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- lib/finance/classify.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/finance/classify.ts lib/finance/classify.test.ts
git commit -m "fix(finance): split ingredient_deposit from materials_packaging in classify"
```

---

## Task 3: Fix `export/invoice/route.ts` — type, source, batch links

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `InvoiceType` (`"export_invoice"`) from Task 1
- Produces: `invoices` rows with `invoice_type = 'export_invoice'`, correct `source`, and `invoice_batch_links` entries

There are three write paths in this file: `generate`, `record`, and `mark_paid`. Each needs the same three fixes: correct type, correct source, and batch link creation. Additionally the initial `export_transactions` select is missing `batch_id`.

- [ ] **Step 1: Add `batch_id` to the initial select**

Around line 43–46, change the select:

```ts
// before
const { data: txs, error: txErr } = await supabase
  .from("export_transactions")
  .select("id, recipient_id, recipient_name, status, invoice_id")
  .in("id", transactionIds);

// after
const { data: txs, error: txErr } = await supabase
  .from("export_transactions")
  .select("id, recipient_id, recipient_name, status, invoice_id, batch_id")
  .in("id", transactionIds);
```

- [ ] **Step 2: Fix the `generate` action**

Find the `invoices` upsert inside the `generate` block (around line 108–128). Change `invoice_type`:

```ts
// before
invoice_type: "standard",

// after
invoice_type: "export_invoice",
```

Immediately after the guard `if (invErr || !inv)` block (after line ~134), add batch link creation. Insert after the existing `export_transactions` update block that sets `invoice_id` (around line 152–161), just before the final `return`:

```ts
    // Create invoice_batch_links for distinct batches covered by these transactions
    const batchIds = [...new Set(
      txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
    )];
    if (batchIds.length > 0) {
      await supabase.from("invoice_batch_links").upsert(
        batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
        { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
      );
    }

    return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
```

- [ ] **Step 3: Fix the `record` action — source bug**

Find the broken `dbSource` line (around line 289):

```ts
// before
// invoices.source only allows 'quickbooks' | 'square' — map 'other' to 'quickbooks'
const dbSource = source === "quickbooks" ? "quickbooks" : "quickbooks"; // TODO: add 'other' to constraint if needed

// after
const dbSource = source as "quickbooks" | "other";
```

Also remove the now-obsolete comment on the `upsert` call a few lines below that says `// invoices.source only allows 'quickbooks' | 'square' — map 'other' to 'quickbooks'`.

- [ ] **Step 4: Fix the `record` action — type**

In the same `record` block, find the `invoices` upsert (around line 291–310). Change:

```ts
// before
invoice_type: "standard",

// after
invoice_type: "export_invoice",
```

- [ ] **Step 5: Fix the `record` action — batch links**

In the `record` block, find the existing `if (inv?.id)` block (around line 312–329) that inserts line items and updates `export_transactions`. Add batch link creation inside it, after the `export_transactions` update:

```ts
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

      // Create invoice_batch_links for distinct batches
      const batchIds = [...new Set(
        txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
      )];
      if (batchIds.length > 0) {
        await supabase.from("invoice_batch_links").upsert(
          batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
      }
    }
```

- [ ] **Step 6: Fix the `mark_paid` action — source**

Find the hardcoded `source: "quickbooks"` in the `mark_paid` `invoices` upsert (around line 365–380). Change:

```ts
// before
// invoices.source only allows 'quickbooks' | 'square' — 'other' maps to 'quickbooks'
{
  source:         "quickbooks",
  ...
}

// after
{
  source:         source as "quickbooks" | "other",
  ...
}
```

Also remove the obsolete comment.

- [ ] **Step 7: Fix the `mark_paid` action — type**

In the same upsert object, change:

```ts
// before
invoice_type: "standard",

// after
invoice_type: "export_invoice",
```

- [ ] **Step 8: Fix the `mark_paid` action — batch links**

Find the `if (inv?.id)` block in `mark_paid` (around line 384–389). Add batch link creation:

```ts
    if (inv?.id) {
      await supabase
        .from("export_transactions")
        .update({ invoice_id: inv.id })
        .in("id", transactionIds);

      // Create invoice_batch_links for distinct batches
      const batchIds = [...new Set(
        txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
      )];
      if (batchIds.length > 0) {
        await supabase.from("invoice_batch_links").upsert(
          batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
      }
    }
```

- [ ] **Step 9: Verify build**

```bash
npm run build 2>&1 | tail -20
```

Expected: no type errors.

- [ ] **Step 10: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "fix(export): invoice_type=export_invoice, fix other source, add batch links"
```

---

## Task 4: Fix `export/invoices/route.ts` — type filter

**Files:**
- Modify: `app/api/production/export/invoices/route.ts`

**Interfaces:**
- Consumes: `invoice_type = 'export_invoice'` in the DB (set by Task 7 migration backfill)

- [ ] **Step 1: Change the type filter**

Line 29:

```ts
// before
.eq("invoice_type", "standard")

// after
.eq("invoice_type", "export_invoice")
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/production/export/invoices/route.ts
git commit -m "fix(export): filter invoices list by export_invoice type"
```

---

## Task 5: Fix `allocations/[id]/invoice/route.ts` — category and source

**Files:**
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`

**Interfaces:**
- Consumes: `"ingredient_deposit"` from `InvoiceLineCategory` (Task 1)

Two fixes: (a) `upsertFinanceLedgerInvoice` uses `"other_services"` for deposit line items — should be `"ingredient_deposit"`. (b) `mark_paid` hardcodes `source: "quickbooks"` even when the caller passes `source: "other"`.

- [ ] **Step 1: Fix deposit line item category in `upsertFinanceLedgerInvoice`**

Near the bottom of the file, find the `invoice_line_items` upsert inside `upsertFinanceLedgerInvoice` (around line 509–519):

```ts
// before
await adminSupabase
  .from("invoice_line_items")
  .upsert(
    {
      invoice_id:       inv.id,
      sort_order:       0,
      description:      "Ingredient Deposit",
      category:         "other_services",
      quantity:         1,
      unit_price_cents: p.depositCents,
      total_cents:      p.depositCents,
    },
    { onConflict: "invoice_id,sort_order" }
  );

// after
await adminSupabase
  .from("invoice_line_items")
  .upsert(
    {
      invoice_id:       inv.id,
      sort_order:       0,
      description:      "Ingredient Deposit",
      category:         "ingredient_deposit",
      quantity:         1,
      unit_price_cents: p.depositCents,
      total_cents:      p.depositCents,
    },
    { onConflict: "invoice_id,sort_order" }
  );
```

- [ ] **Step 2: Fix `mark_paid` source**

Find the `mark_paid` action's `invoices` upsert (around line 402–421). Change hardcoded source:

```ts
// before
const { data: inv } = await adminSupabase
  .from("invoices")
  .upsert(
    {
      source:        "quickbooks",
      ...
    },
    ...
  )

// after
const { data: inv } = await adminSupabase
  .from("invoices")
  .upsert(
    {
      source:        source === "quickbooks" ? "quickbooks" : "other",
      ...
    },
    ...
  )
```

- [ ] **Step 3: Verify build**

```bash
npm run build 2>&1 | tail -10
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add "app/api/production/allocations/[id]/invoice/route.ts"
git commit -m "fix(deposit): ingredient_deposit category, fix mark_paid source passthrough"
```

---

## Task 6: Finance invoices page — add `export_invoice` filter option

**Files:**
- Modify: `app/finance/invoices/page.tsx`

**Interfaces:**
- Consumes: `InvoiceType` from Task 1 (the page already imports and uses this type)

- [ ] **Step 1: Add `export_invoice` to the type filter select**

Find the `typeFilter` select in the JSX (around line 671–677):

```tsx
// before
<select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
  className="inp w-auto">
  <option value="all">All types</option>
  <option value="standard">Standard</option>
  <option value="allocation_deposit">Deposit invoices</option>
</select>

// after
<select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
  className="inp w-auto">
  <option value="all">All types</option>
  <option value="standard">Standard</option>
  <option value="allocation_deposit">Deposit invoices</option>
  <option value="export_invoice">Export invoices</option>
</select>
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | tail -10
```

Expected: no errors. The `typeFilter` state is typed as `"all" | InvoiceType` so it already accepts `"export_invoice"` after Task 1.

- [ ] **Step 3: Commit**

```bash
git add app/finance/invoices/page.tsx
git commit -m "feat(finance): add export_invoice filter to invoices page"
```

---

## Task 7: Migration — extend constraints and backfill existing data

**Files:**
- Create: `supabase/migrations/20260629_invoice_ledger_linkage_fix.sql`

This migration is additive — it only extends check constraints and backfills existing rows. Safe to run against a live database with no downtime.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260629_invoice_ledger_linkage_fix.sql`:

```sql
-- Invoice ledger linkage fix (2026-06-29)
-- 1. Extend invoice_type to include 'export_invoice'
-- 2. Extend invoice_line_items.category to include 'ingredient_deposit'
-- 3. Backfill existing export invoices to invoice_type = 'export_invoice'
-- 4. Create missing invoice_batch_links for export invoices
-- 5. Fix 'other' source rows wrongly stored as 'quickbooks'
-- 6. Fix deposit line items from 'other_services' to 'ingredient_deposit'

-- ── 1. Extend invoice_type ────────────────────────────────────────────────────
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN ('standard', 'allocation_deposit', 'export_invoice'));

-- ── 2. Extend invoice_line_items.category ─────────────────────────────────────
ALTER TABLE public.invoice_line_items
  DROP CONSTRAINT IF EXISTS invoice_line_items_category_check;
ALTER TABLE public.invoice_line_items
  ADD CONSTRAINT invoice_line_items_category_check
  CHECK (category IN (
    'ingredient_deposit',
    'materials_packaging',
    'packaging_fees',
    'other_services',
    'pass_through_taxes',
    'distribution_keg',
    'distribution_can',
    'other'
  ));

-- ── 3. Backfill invoice_type for existing export invoices ─────────────────────
-- Export invoices are identified by the existence of an export_transactions row
-- pointing to them. QB-imported standard invoices have no such link.
UPDATE public.invoices i
SET invoice_type = 'export_invoice'
WHERE i.invoice_type = 'standard'
  AND EXISTS (
    SELECT 1 FROM public.export_transactions et
    WHERE et.invoice_id = i.id
  );

-- ── 4. Create missing invoice_batch_links for export invoices ─────────────────
-- Each export invoice should have a link for every distinct batch across its
-- transactions. These were never created at generation time.
INSERT INTO public.invoice_batch_links (invoice_id, batch_id)
SELECT DISTINCT et.invoice_id, et.batch_id
FROM public.export_transactions et
WHERE et.invoice_id IS NOT NULL
  AND et.batch_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.invoice_batch_links ibl
    WHERE ibl.invoice_id = et.invoice_id
      AND ibl.batch_id = et.batch_id
  )
ON CONFLICT (invoice_id, batch_id) DO NOTHING;

-- ── 5. Fix 'other' source rows stored as 'quickbooks' ────────────────────────
-- The 'record' and 'mark_paid' actions had a bug that always wrote 'quickbooks'
-- even when source was 'other'. These rows are safely identified by their
-- external_id pattern (generated as 'other:<uuid>' for non-QB manual records).
UPDATE public.invoices
SET source = 'other'
WHERE source = 'quickbooks'
  AND external_id LIKE 'other:%';

-- ── 6. Fix deposit line item categories ───────────────────────────────────────
-- Deposit line items were stored as 'other_services'; correct category is
-- 'ingredient_deposit' which maps to a separate GL account from packaging materials.
UPDATE public.invoice_line_items
SET category = 'ingredient_deposit'
WHERE description = 'Ingredient Deposit'
  AND category = 'other_services';
```

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push 2>&1 | tail -20
```

Expected: migration applies cleanly with no errors.

- [ ] **Step 3: Verify backfills**

Run these verification queries via the Supabase dashboard SQL editor or `supabase db query`:

```sql
-- Should be 0 (all export invoices reclassified)
SELECT COUNT(*) FROM invoices i
WHERE i.invoice_type = 'standard'
  AND EXISTS (SELECT 1 FROM export_transactions et WHERE et.invoice_id = i.id);

-- Should show counts > 0 if export invoices exist
SELECT invoice_type, COUNT(*) FROM invoices GROUP BY invoice_type ORDER BY invoice_type;

-- Should be 0 (all deposit items reclassified)
SELECT COUNT(*) FROM invoice_line_items
WHERE description = 'Ingredient Deposit' AND category = 'other_services';

-- Should be 0 (other source rows fixed)
SELECT COUNT(*) FROM invoices
WHERE source = 'quickbooks' AND external_id LIKE 'other:%';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260629_invoice_ledger_linkage_fix.sql
git commit -m "feat(db): extend invoice_type/category constraints, backfill export invoices"
```

---

## Self-Review

**Spec coverage:**
- ✅ `"export_invoice"` added to `InvoiceType` (Task 1)
- ✅ `"ingredient_deposit"` added to `InvoiceLineCategory` (Task 1)
- ✅ `classify.ts` routes ingredient deposit separately (Task 2)
- ✅ All three export invoice write paths fixed: type, source, batch links (Task 3)
- ✅ Production export invoices list filter updated (Task 4)
- ✅ Deposit line item category fixed (Task 5)
- ✅ Deposit `mark_paid` source fixed (Task 5)
- ✅ Finance page filter updated (Task 6)
- ✅ Migration with all 4 backfills (Task 7)

**Placeholder scan:** No TBDs, all code blocks are complete.

**Type consistency:** `"ingredient_deposit"` defined in Task 1, used in Tasks 2 and 5. `"export_invoice"` defined in Task 1, used in Tasks 3, 4, 6, 7. All consistent.
