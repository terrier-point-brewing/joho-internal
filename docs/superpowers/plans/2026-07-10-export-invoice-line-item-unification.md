# Export + Deposit Invoice Line-Item Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make export and deposit invoices persist and render one canonical line-item shape sourced from Square's authoritative order, fixing description drift, the missing-discount/gross-total bug, and GL auto-map.

**Architecture:** Extract the "Square order line → `invoice_line_items` row" mapping into one shared module (`lib/finance/invoiceLineItems.ts`). Both the Square year-sync and the two `generate` flows (export + deposit) fetch the created order back and write rows through that single mapper, so all paths produce byte-identical rows. GL auto-map keys off `square_catalog_variation_id` (description match as fallback). The finance invoices tab renders a 7-column layout + discount/tax summary rows.

**Tech Stack:** Next.js 16 App Router (TS), Supabase Postgres (raw SQL migrations), Square REST API v2 (`2025-04-16`), Vitest.

## Global Constraints

- Money is integer **cents** everywhere; `net_sales_cents = gross_sales_cents − discount_cents`; line **Total** column = `net_sales_cents` (pre-tax); invoice `total_cents` = Square `order.total_money` (authoritative).
- Snapshot catalog names at write time (`line_item_name`, `variation_name`) — no live catalog join on render.
- COA prefill is **fill-nulls-only** (never overwrite a non-null `chart_of_accounts_id`) — reuse existing `resolveLineItemCoa`.
- New migration files only; never edit existing migrations. Prod apply is manual, one migration at a time, per `feedback_prod_db_migration_authorization`.
- New/modified `lib/` modules ship co-located `*.test.ts`; keep coverage above the `vitest.config.ts` floor. CI runs `npm run test`.
- No raw color utilities / hand-rolled primitives in UI (`docs/UI_STANDARD.md`); reuse token utilities.
- One shared mapper/renderer — no invoice-type-specific forks of persistence or display.

---

## File Structure

- **Create** `lib/finance/invoiceLineItems.ts` — shared order→row mapping, index builder, persist helper, header-totals helper.
- **Create** `lib/finance/invoiceLineItems.test.ts` — unit tests for the above.
- **Modify** `lib/finance/syncSquareInvoices.ts` — use the shared mapper/indexes/persist instead of inline logic.
- **Modify** `app/api/production/export/invoice/route.ts` — `generate` reads the created order back and persists via the shared mapper; header totals from order.
- **Modify** `app/api/production/allocations/[id]/invoice/route.ts` — `generate` uses the shared mapper (delete `upsertFinanceLedgerInvoice`'s bespoke line insert; keep a header upsert).
- **Modify** `app/api/finance/ledger/invoices/auto-map/route.ts` — variation-primary GL resolution.
- **Modify** `app/api/finance/ledger/invoices/route.ts` — extend line-item + invoice select with new columns.
- **Modify** `app/finance/transactions/invoices/page.tsx` — 7-column line grid + discount/tax summary rows.
- **Create** `supabase/migrations/20260710_invoice_line_item_unification.sql` — add `line_item_name`, `invoices.discount_cents`, backfill `square_catalog_variation_id`.
- **Create** `supabase/migrations/20260711_drop_legacy_line_item_catalog_refs.sql` — drop retired columns (applied only after backfill verified).
- **Create** `app/api/finance/ledger/backfill-invoice-lines/route.ts` — one-shot re-sync backfill for `export_invoice` + `allocation_deposit`.

---

## Task 1: Migration — add columns + consolidate catalog ref

**Files:**
- Create: `supabase/migrations/20260710_invoice_line_item_unification.sql`

**Interfaces:**
- Produces: new columns `invoice_line_items.line_item_name text`, `invoices.discount_cents bigint`; `invoice_line_items.square_catalog_variation_id` backfilled from `square_variation_id`/`square_catalog_object_id`.

- [ ] **Step 1: Write the migration**

```sql
-- 20260710_invoice_line_item_unification.sql
-- Unify export/deposit/sync invoice line items onto one canonical shape.

-- 1. Snapshot catalog item name (variation_name already exists).
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS line_item_name text;

-- 2. Invoice-level (order-scoped) discount total.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS discount_cents bigint;

-- 3. Consolidate the three catalog-ref columns into square_catalog_variation_id.
UPDATE public.invoice_line_items
   SET square_catalog_variation_id = COALESCE(square_catalog_variation_id, square_variation_id, square_catalog_object_id)
 WHERE square_catalog_variation_id IS NULL
   AND (square_variation_id IS NOT NULL OR square_catalog_object_id IS NOT NULL);

COMMENT ON COLUMN public.invoice_line_items.line_item_name IS 'Snapshot of Square catalog item name at invoicing (col 1 = line_item_name — variation_name).';
COMMENT ON COLUMN public.invoices.discount_cents IS 'Order-scoped (invoice-level) discount total in cents; line-scoped discounts live on invoice_line_items.discount_cents.';
```

- [ ] **Step 2: Verify it parses (dry sanity check locally, do NOT apply to prod)**

Run: `grep -c "ADD COLUMN IF NOT EXISTS" supabase/migrations/20260710_invoice_line_item_unification.sql`
Expected: `2`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260710_invoice_line_item_unification.sql
git commit -m "feat(db): add line_item_name, invoices.discount_cents; consolidate catalog ref"
```

> **Prod apply:** hand to the orchestrator/user for manual apply (explicit OK + backup) before Task 7/8 UI reads the new columns. Later tasks assume these columns exist.

---

## Task 2: Shared order→row mapping module

**Files:**
- Create: `lib/finance/invoiceLineItems.ts`
- Test: `lib/finance/invoiceLineItems.test.ts`

**Interfaces:**
- Consumes: `Order`, `OrderLineItem`, `CatalogItem` from `@/types/square`; `InvoiceLineCategory` from `@/types/finance`; `buildKegIndex` from `@/lib/reports/kegs`; `canOzPerUnit` from `@/lib/reports/bbl-tracker`; `CATEGORY_IDS` from `@/lib/constants/categories`; `classifyLineItem` from `@/lib/finance/classify`.
- **Note (avoid circular import):** `LineItemCoa` + `resolveLineItemCoa` are **defined here** (moved out of `syncSquareInvoices.ts`). Task 3 makes `syncSquareInvoices.ts` re-export them, so `syncSquareInvoices.test.ts` keeps working unchanged and there is no import cycle.
- Produces:
  - `interface LineItemCoa { chart_of_accounts_id: string | null; bs_chart_of_accounts_id: string | null; pl_chart_of_accounts_id: string | null }`
  - `resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa`
  - `interface LineItemIndexes { kegIndex: Map<string, unknown>; canVariationOz: Map<string, number>; variationById: Map<string, { chart_of_accounts_id_invoice: string | null; bs_chart_of_accounts_id: string | null; pl_chart_of_accounts_id: string | null }>; itemNameByVariationId: Map<string, string> }`
  - `buildLineItemIndexes(supabase, catalogItems: CatalogItem[]): Promise<LineItemIndexes>`
  - `interface CanonicalLineItemRow { invoice_id: string; sort_order: number; line_item_name: string | null; variation_name: string | null; description: string; note: string | null; category: InvoiceLineCategory | null; quantity: number; unit_price_cents: number; gross_sales_cents: number; discount_cents: number; net_sales_cents: number; tax_cents: number; total_cents: number; square_catalog_variation_id: string | null; chart_of_accounts_id: string | null; bs_chart_of_accounts_id: string | null; pl_chart_of_accounts_id: string | null }`
  - `buildInvoiceLineItemRows(invoiceId: string, order: Order, indexes: LineItemIndexes, existingCoaBySort: Map<number, LineItemCoa>): CanonicalLineItemRow[]`
  - `invoiceHeaderTotalsFromOrder(order: Order): { subtotal_cents: number; tax_cents: number; discount_cents: number; total_cents: number }`
  - `persistInvoiceLineItems(supabase, invoiceId: string, rows: CanonicalLineItemRow[]): Promise<{ error?: string }>`

- [ ] **Step 1: Write failing tests**

```ts
// lib/finance/invoiceLineItems.test.ts
import { describe, it, expect } from "vitest";
import { buildInvoiceLineItemRows, invoiceHeaderTotalsFromOrder, type LineItemIndexes } from "./invoiceLineItems";
import type { Order } from "@/types/square";

const emptyIndexes: LineItemIndexes = {
  kegIndex: new Map(),
  canVariationOz: new Map(),
  variationById: new Map(),
  itemNameByVariationId: new Map([["VAR1", "Barrel Excise Tax"]]),
};

function orderWith(lineItems: Order["line_items"], discounts?: Order["discounts"]): Order {
  return {
    id: "O1", location_id: "L", state: "OPEN", created_at: "2026-07-11T00:00:00Z",
    line_items: lineItems, discounts,
    total_money: { amount: 0, currency: "USD" },
  } as Order;
}

describe("buildInvoiceLineItemRows", () => {
  it("splits catalog identity (col1) from note (col2) and computes net = gross - discount", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax",
        variation_name: "Regular", note: "TTB (1.50 bbls)",
        base_price_money: { amount: 525, currency: "USD" },
        gross_sales_money: { amount: 525, currency: "USD" },
        total_discount_money: { amount: 0, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 525, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.line_item_name).toBe("Barrel Excise Tax");
    expect(row.variation_name).toBe("Regular");
    expect(row.note).toBe("TTB (1.50 bbls)");
    expect(row.square_catalog_variation_id).toBe("VAR1");
    expect(row.gross_sales_cents).toBe(525);
    expect(row.net_sales_cents).toBe(525);
    expect(row.total_cents).toBe(525);
  });

  it("records a line-scoped discount and nets it out of total", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VARX", quantity: "40", name: "Vienna Lager (Keg)",
        variation_name: "1/6 Keg",
        base_price_money: { amount: 7900, currency: "USD" },
        gross_sales_money: { amount: 316000, currency: "USD" },
        total_discount_money: { amount: 94800, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 221200, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.discount_cents).toBe(94800);
    expect(row.net_sales_cents).toBe(221200);
    expect(row.total_cents).toBe(221200);
  });

  it("keeps two same-variation lines distinct via note; both map to the same variation id", () => {
    const order = orderWith([
      { uid: "a", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "TTB (1.50 bbls)", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
      { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "NC Dept of Revenue (46.50 gal)", gross_sales_money: { amount: 2883, currency: "USD" }, total_money: { amount: 2883, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(rows).toHaveLength(2);
    expect(rows[0].note).not.toBe(rows[1].note);
    expect(rows[0].square_catalog_variation_id).toBe(rows[1].square_catalog_variation_id);
  });

  it("preserves an existing non-null COA (fill-nulls-only)", () => {
    const order = orderWith([
      { uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
    ]);
    const existing = new Map([[0, { chart_of_accounts_id: "USER-SET", bs_chart_of_accounts_id: null, pl_chart_of_accounts_id: null }]]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, existing);
    expect(row.chart_of_accounts_id).toBe("USER-SET");
  });
});

describe("invoiceHeaderTotalsFromOrder", () => {
  it("uses order.total_money as authoritative and sums order-scoped discounts", () => {
    const order = orderWith(
      [{ uid: "u", quantity: "1", name: "x", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } }],
      [{ uid: "d", name: "Coupon", scope: "ORDER", applied_money: { amount: 50, currency: "USD" } }],
    );
    (order as { total_money: { amount: number; currency: string } }).total_money = { amount: 50, currency: "USD" };
    (order as { total_tax_money?: { amount: number; currency: string } }).total_tax_money = { amount: 0, currency: "USD" };
    const t = invoiceHeaderTotalsFromOrder(order);
    expect(t.total_cents).toBe(50);
    expect(t.discount_cents).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/finance/invoiceLineItems.test.ts`
Expected: FAIL (module `./invoiceLineItems` not found).

- [ ] **Step 3: Implement the module**

```ts
// lib/finance/invoiceLineItems.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem, Order } from "@/types/square";
import type { InvoiceLineCategory } from "@/types/finance";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";

export interface LineItemCoa {
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
}

/**
 * Fill-nulls-only COA resolution: an existing non-null mapping always wins;
 * the variation prefill only fills gaps. Keeps re-syncs non-destructive.
 */
export function resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa {
  return {
    chart_of_accounts_id:    existing?.chart_of_accounts_id    ?? prefill.chart_of_accounts_id,
    bs_chart_of_accounts_id: existing?.bs_chart_of_accounts_id ?? prefill.bs_chart_of_accounts_id,
    pl_chart_of_accounts_id: existing?.pl_chart_of_accounts_id ?? prefill.pl_chart_of_accounts_id,
  };
}

export interface LineItemIndexes {
  kegIndex: ReturnType<typeof buildKegIndex>;
  canVariationOz: Map<string, number>;
  variationById: Map<string, {
    chart_of_accounts_id_invoice: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
  }>;
  itemNameByVariationId: Map<string, string>;
}

export interface CanonicalLineItemRow {
  invoice_id: string;
  sort_order: number;
  line_item_name: string | null;
  variation_name: string | null;
  description: string;
  note: string | null;
  category: InvoiceLineCategory | null;
  quantity: number;
  unit_price_cents: number;
  gross_sales_cents: number;
  discount_cents: number;
  net_sales_cents: number;
  tax_cents: number;
  total_cents: number;
  square_catalog_variation_id: string | null;
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
}

export async function buildLineItemIndexes(
  supabase: SupabaseClient,
  catalogItems: CatalogItem[],
): Promise<LineItemIndexes> {
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  const itemNameByVariationId = new Map<string, string>();
  for (const item of catalogItems) {
    const isCan = CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "");
    for (const v of item.item_data.variations ?? []) {
      itemNameByVariationId.set(v.id, item.item_data.name);
      if (isCan) canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  const { data: variationMappings } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id_invoice, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
    .or("bs_chart_of_accounts_id.not.is.null,pl_chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");

  const variationById = new Map(
    (variationMappings ?? []).map((v) => [v.square_variation_id, {
      chart_of_accounts_id_invoice: v.chart_of_accounts_id_invoice,
      bs_chart_of_accounts_id: v.bs_chart_of_accounts_id,
      pl_chart_of_accounts_id: v.pl_chart_of_accounts_id,
    }]),
  );

  return { kegIndex, canVariationOz, variationById, itemNameByVariationId };
}

export function buildInvoiceLineItemRows(
  invoiceId: string,
  order: Order,
  indexes: LineItemIndexes,
  existingCoaBySort: Map<number, LineItemCoa>,
): CanonicalLineItemRow[] {
  const { kegIndex, canVariationOz, variationById, itemNameByVariationId } = indexes;

  const carveOutAmounts = (order.discounts ?? [])
    .filter((d) => d.name.toLowerCase().includes("carve out"))
    .map((d) => d.applied_money?.amount ?? 0)
    .filter((a) => a > 0);

  const rows: CanonicalLineItemRow[] = [];
  (order.line_items ?? []).forEach((li, i) => {
    const qty     = parseFloat(li.quantity ?? "1");
    const varId   = li.catalog_object_id ?? "";
    const varName = li.variation_name ?? "";
    const gross   = li.gross_sales_money?.amount ?? 0;
    const discount = li.total_discount_money?.amount ?? 0;
    const tax      = li.total_tax_money?.amount ?? 0;

    let category: InvoiceLineCategory | null = null;
    if (kegIndex.get(varId)) category = "distribution_keg";
    if (!category && canVariationOz.has(varId)) category = "distribution_can";
    if (!category && li.name.toLowerCase().includes("barrel excise tax")) {
      const idx = carveOutAmounts.findIndex((a) => Math.abs(a - gross) <= 1);
      if (idx >= 0) { carveOutAmounts.splice(idx, 1); return; }
    }
    if (!category) category = classifyLineItem(li.name);

    const varMapping = varId ? variationById.get(varId) : undefined;
    const coa = resolveLineItemCoa(existingCoaBySort.get(i), {
      chart_of_accounts_id:    varMapping?.chart_of_accounts_id_invoice ?? null,
      bs_chart_of_accounts_id: varMapping?.bs_chart_of_accounts_id ?? null,
      pl_chart_of_accounts_id: varMapping?.pl_chart_of_accounts_id ?? null,
    });

    const lineName = varId ? (itemNameByVariationId.get(varId) ?? li.name) : li.name;
    const net = gross - discount;

    rows.push({
      invoice_id: invoiceId,
      sort_order: i,
      line_item_name: lineName || null,
      variation_name: varName || null,
      description: li.name + (varName ? ` — ${varName}` : ""),
      note: li.note ?? null,
      category,
      quantity: qty,
      unit_price_cents: li.base_price_money?.amount ?? 0,
      gross_sales_cents: gross,
      discount_cents: discount,
      net_sales_cents: net,
      tax_cents: tax,
      total_cents: net,
      square_catalog_variation_id: varId || null,
      chart_of_accounts_id: coa.chart_of_accounts_id,
      bs_chart_of_accounts_id: coa.bs_chart_of_accounts_id,
      pl_chart_of_accounts_id: coa.pl_chart_of_accounts_id,
    });
  });

  return rows;
}

export function invoiceHeaderTotalsFromOrder(order: Order) {
  const total = order.total_money?.amount ?? 0;
  const tax   = order.total_tax_money?.amount ?? 0;
  const orderDiscount = (order.discounts ?? [])
    .filter((d) => (d.scope ?? "").toUpperCase() === "ORDER")
    .reduce((s, d) => s + (d.applied_money?.amount ?? 0), 0);
  const subtotal = total - tax + orderDiscount;
  return { subtotal_cents: subtotal, tax_cents: tax, discount_cents: orderDiscount, total_cents: total };
}

export async function persistInvoiceLineItems(
  supabase: SupabaseClient,
  invoiceId: string,
  rows: CanonicalLineItemRow[],
): Promise<{ error?: string }> {
  if (rows.length === 0) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    return {};
  }
  const { error } = await supabase
    .from("invoice_line_items")
    .upsert(rows, { onConflict: "invoice_id,sort_order", ignoreDuplicates: false });
  if (error) return { error: error.message };
  await supabase
    .from("invoice_line_items")
    .delete()
    .eq("invoice_id", invoiceId)
    .gt("sort_order", rows.length - 1);
  return {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/finance/invoiceLineItems.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/finance/invoiceLineItems.ts lib/finance/invoiceLineItems.test.ts
git commit -m "feat(finance): shared Square order -> canonical invoice line-item mapping"
```

---

## Task 3: Refactor year-sync onto the shared mapper

**Files:**
- Modify: `lib/finance/syncSquareInvoices.ts`

**Interfaces:**
- Consumes: `buildLineItemIndexes`, `buildInvoiceLineItemRows`, `persistInvoiceLineItems` from `./invoiceLineItems`.
- Produces: unchanged `syncSquareInvoicesForYear` signature and `SyncSquareInvoicesResult`.

- [ ] **Step 1: Move the COA helper out, then re-export it (breaks the import cycle)**

Delete the `LineItemCoa` interface and `resolveLineItemCoa` function definitions from `syncSquareInvoices.ts` (current lines ~12-30) — they now live in `invoiceLineItems.ts` (Task 2). Add at the top of `syncSquareInvoices.ts` a re-export so existing importers (`syncSquareInvoices.test.ts`) keep working:

```ts
export { resolveLineItemCoa, type LineItemCoa } from "./invoiceLineItems";
import { buildLineItemIndexes, buildInvoiceLineItemRows, persistInvoiceLineItems, type LineItemCoa } from "./invoiceLineItems";
```

- [ ] **Step 2: Replace the inline index-building with the shared builder**

In `syncSquareInvoicesForYear`, after `catalogItems` is fetched, delete the inline `kegIndex` / `canVariationOz` / `variationMappings` / `variationById` blocks (current lines ~84-109) and replace with:

```ts
const indexes = await buildLineItemIndexes(supabase, catalogItems);
```

- [ ] **Step 3: Replace the per-invoice line-item block**

Replace the current per-invoice block that builds `lineItems`, upserts, and deletes stragglers (current lines ~171-263) with:

```ts
    const { data: existingLines } = await supabase
      .from("invoice_line_items")
      .select("sort_order, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
      .eq("invoice_id", invRow.id);
    const existingCoaBySort = new Map<number, LineItemCoa>(
      (existingLines ?? []).map((r) => [r.sort_order as number, {
        chart_of_accounts_id: r.chart_of_accounts_id,
        bs_chart_of_accounts_id: r.bs_chart_of_accounts_id,
        pl_chart_of_accounts_id: r.pl_chart_of_accounts_id,
      }]),
    );

    const rows = buildInvoiceLineItemRows(invRow.id, order, indexes, existingCoaBySort);
    const { error: liErr } = await persistInvoiceLineItems(supabase, invRow.id, rows);
    if (liErr) errors.push(`Line items for ${inv.invoice_number ?? inv.id}: ${liErr}`);
```

Remove now-unused imports (`buildKegIndex`, `canOzPerUnit`, `CATEGORY_IDS`, `classifyLineItem`, `InvoiceLineCategory`) from `syncSquareInvoices.ts` if no longer referenced there.

- [ ] **Step 4: Typecheck + full test run**

Run: `npm run lint && npx vitest run lib/finance`
Expected: PASS (including the unchanged `syncSquareInvoices.test.ts` via the re-export), no type errors, no unused-import warnings.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/syncSquareInvoices.ts
git commit -m "refactor(finance): year-sync uses shared invoice line-item mapper"
```

---

## Task 4: Export generate — order read-back

**Files:**
- Modify: `app/api/production/export/invoice/route.ts`

**Interfaces:**
- Consumes: `fetchOrdersByIds` from `@/lib/square/orders`; `fetchCatalogItems` from `@/lib/square/catalog`; `buildLineItemIndexes`, `buildInvoiceLineItemRows`, `persistInvoiceLineItems`, `invoiceHeaderTotalsFromOrder` from `@/lib/finance/invoiceLineItems`.

- [ ] **Step 1: Add a shared read-back helper call after invoice creation**

In the `generate` branch, after the `invoices` row is upserted (current line ~135, `inv.id` known) and `createExportInvoice` result has `orderId`, replace the current bespoke line-item insert (lines ~137-151) with a read-back:

```ts
    // Persist canonical line items + authoritative header totals from Square's order.
    try {
      const [orders, catalogItems] = await Promise.all([
        fetchOrdersByIds([result.orderId]),
        fetchCatalogItems(),
      ]);
      const order = orders[0];
      if (order) {
        const indexes = await buildLineItemIndexes(supabase, catalogItems as CatalogItem[]);
        const rows = buildInvoiceLineItemRows(inv.id, order, indexes, new Map());
        await persistInvoiceLineItems(supabase, inv.id, rows);
        const totals = invoiceHeaderTotalsFromOrder(order);
        await supabase.from("invoices").update(totals).eq("id", inv.id);
      }
    } catch (err) {
      console.error("[export-invoice] generate read-back failed, falling back to draft values:", err);
      // Fallback: persist gross draft values so the row is never empty; a later sync reconciles.
      if (lineItems.length > 0) {
        await supabase.from("invoice_line_items").insert(
          lineItems.map((li, i) => ({
            invoice_id: inv.id, sort_order: i, description: li.description,
            category: "other_services", quantity: li.quantity,
            unit_price_cents: li.unitPriceCents, total_cents: li.quantity * li.unitPriceCents,
            square_catalog_variation_id: li.squareCatalogVariationId ?? null,
          })),
        );
      }
    }
```

Note: `createExportInvoice` must return `orderId`. Confirm `ExportInvoiceResult` includes it; `createInvoice` already returns `orderId` (see `lib/square/square-invoices.ts:249`). If `createExportInvoice`'s return type omits it, widen the type to include `orderId: string`.

- [ ] **Step 2: Add imports at top of file**

```ts
import { fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildLineItemIndexes, buildInvoiceLineItemRows, persistInvoiceLineItems, invoiceHeaderTotalsFromOrder } from "@/lib/finance/invoiceLineItems";
import type { CatalogItem } from "@/types/square";
```

- [ ] **Step 3: Verify ExportInvoiceResult exposes orderId**

Run: `grep -n "interface ExportInvoiceResult\|createExportInvoice" lib/square/square-invoices.ts`
Expected: return type includes `orderId`. If not, add `orderId: string` to the interface and ensure `createExportInvoice` returns `result.orderId`.

- [ ] **Step 4: Lint + typecheck**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/export/invoice/route.ts lib/square/square-invoices.ts
git commit -m "fix(export-invoice): persist canonical rows + authoritative totals via order read-back"
```

---

## Task 5: Deposit generate — same read-back, delete bespoke insert

**Files:**
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`

**Interfaces:**
- Consumes: same read-back helpers as Task 4.

- [ ] **Step 1: Replace `upsertFinanceLedgerInvoice`'s line-item insert**

In `upsertFinanceLedgerInvoice` (lines ~457-505), keep the header `invoices` upsert but **remove** the bespoke `invoice_line_items` upsert (lines ~488-502). Return `inv.id` as before.

- [ ] **Step 2: Add the read-back after the ledger header upsert in `generate`**

After `ledgerInvoiceId` is obtained (line ~197-208) and the Square `result.orderId` is known, add:

```ts
    if (ledgerInvoiceId) {
      try {
        const [orders, catalogItems] = await Promise.all([
          fetchOrdersByIds([result.orderId]),
          fetchCatalogItems(),
        ]);
        const order = orders[0];
        if (order) {
          const indexes = await buildLineItemIndexes(adminSupabase, catalogItems as CatalogItem[]);
          const rows = buildInvoiceLineItemRows(ledgerInvoiceId, order, indexes, new Map());
          await persistInvoiceLineItems(adminSupabase, ledgerInvoiceId, rows);
          const totals = invoiceHeaderTotalsFromOrder(order);
          await adminSupabase.from("invoices").update(totals).eq("id", ledgerInvoiceId);
        }
      } catch (err) {
        console.error("[deposit-invoice] generate read-back failed, using draft deposit line:", err);
        await adminSupabase.from("invoice_line_items").upsert(
          {
            invoice_id: ledgerInvoiceId, sort_order: 0, description: "Ingredient Deposit",
            category: "ingredient_deposit", quantity: 1,
            unit_price_cents: calculation.deposit_cents, total_cents: calculation.deposit_cents,
            square_catalog_variation_id: mapping.square_catalog_variation_id,
          },
          { onConflict: "invoice_id,sort_order" },
        );
      }
    }
```

`result.orderId` comes from `createDepositInvoice`/`reviseDepositInvoice` (both return `orderId` via `createInvoice`). The allocation already stores `square_deposit_order_id: result.orderId` (line ~186).

- [ ] **Step 3: Add imports**

```ts
import { fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildLineItemIndexes, buildInvoiceLineItemRows, persistInvoiceLineItems, invoiceHeaderTotalsFromOrder } from "@/lib/finance/invoiceLineItems";
import type { CatalogItem } from "@/types/square";
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/production/allocations/[id]/invoice/route.ts
git commit -m "fix(deposit-invoice): persist canonical rows via shared order read-back"
```

---

## Task 6: Auto-map keyed off the variation

**Files:**
- Modify: `app/api/finance/ledger/invoices/auto-map/route.ts`

- [ ] **Step 1: Extend the item select to include the variation id**

Change the line-items query select (line ~28) to add `square_catalog_variation_id`:

```ts
    .select("id, description, variation_name, square_catalog_variation_id, chart_of_accounts_id, invoices!invoice_line_items_invoice_id_fkey!inner(invoice_date)")
```

- [ ] **Step 2: Build a variation→COA map and resolve it first**

After the existing `variations` fetch, build a `coaByVariationId` map and apply it before the description fallback:

```ts
  const coaByVariationId = new Map<string, string>();
  const { data: varMaps } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id, chart_of_accounts_id_invoice")
    .or("chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");
  for (const v of varMaps ?? []) {
    const coaId = v.chart_of_accounts_id_invoice ?? v.chart_of_accounts_id;
    if (coaId) coaByVariationId.set(v.square_variation_id, coaId);
  }

  function resolveCoa(item: { square_catalog_variation_id: string | null; description: string | null }): string | undefined {
    if (item.square_catalog_variation_id && coaByVariationId.has(item.square_catalog_variation_id)) {
      return coaByVariationId.get(item.square_catalog_variation_id);
    }
    if (item.description && coaByDescription.has(item.description.trim().toLowerCase())) {
      return coaByDescription.get(item.description.trim().toLowerCase());
    }
    return undefined;
  }
```

- [ ] **Step 3: Use `resolveCoa` in the update filter/map**

Replace the `toUpdate` filter and the update call to use `resolveCoa`:

```ts
  const toUpdate = allItems
    .filter((item) => !item.chart_of_accounts_id)
    .map((item) => ({ item, coaId: resolveCoa(item) }))
    .filter((x): x is { item: typeof x.item; coaId: string } => !!x.coaId);

  if (toUpdate.length === 0) return NextResponse.json({ mapped: 0 });

  const results = await Promise.allSettled(
    toUpdate.map(({ item, coaId }) =>
      supabase.from("invoice_line_items").update({ chart_of_accounts_id: coaId }).eq("id", item.id)
    )
  );
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/finance/ledger/invoices/auto-map/route.ts
git commit -m "fix(finance): invoice auto-map keys off catalog variation, description fallback"
```

---

## Task 7: Extend the ledger invoices select

**Files:**
- Modify: `app/api/finance/ledger/invoices/route.ts`

- [ ] **Step 1: Add the new columns to the select**

In the GET select (line ~20-23), add `line_item_name, note, discount_cents, net_sales_cents, square_catalog_variation_id` to the `invoice_line_items(...)` projection, and add `discount_cents` to the top-level `invoices` columns.

```ts
      invoice_line_items!invoice_line_items_invoice_id_fkey( id, sort_order, line_item_name, description, note, category, quantity, unit_price_cents, discount_cents, net_sales_cents, total_cents, variation_name, square_catalog_variation_id, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id, delivery_invoice_id, account_mode, chart_of_accounts!invoice_line_items_chart_of_accounts_id_fkey( id, account_name, account_number, account_type ) ),
```

Ensure `discount_cents` (invoice level) and `tax_cents` are in the invoices column list.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/finance/ledger/invoices/route.ts
git commit -m "feat(finance): expose line_item_name/note/discount in ledger invoices API"
```

---

## Task 8: Finance invoices tab — 7-column + summary rows

**Files:**
- Modify: `app/finance/transactions/invoices/page.tsx`

- [ ] **Step 1: Extend the `InvoiceLineItemRow` interface**

Add to the interface (line ~47-62): `line_item_name: string | null; note: string | null; discount_cents: number | null; net_sales_cents: number | null; square_catalog_variation_id: string | null;` and add `discount_cents: number | null` to `InvoiceRow`/`Invoice` usage as needed.

- [ ] **Step 2: Update the expanded-row header grid to 7 columns**

Replace the header grid (lines ~152-158) and each line row grid (lines ~218) template with a 7-column layout:

```tsx
<div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_50px_80px_70px_80px_minmax(0,1fr)] gap-3 px-10 py-1.5 bg-surface/40 text-[10px] text-faint uppercase tracking-wider">
  <span>Line item</span>
  <span>Description</span>
  <span className="text-right">Qty</span>
  <span className="text-right">Unit</span>
  <span className="text-right">Disc</span>
  <span className="text-right">Total</span>
  <span>GL Account</span>
</div>
```

- [ ] **Step 3: Render col1 (catalog identity) + col2 (note) + discount**

In `InvoiceLineItemRow`, render:
- col1 = `item.line_item_name ? item.line_item_name + (item.variation_name ? \` — \${item.variation_name}\` : "") : item.description`
- col2 = `item.note ?? "—"` (faint when null)
- col5 discount = `item.discount_cents ? formatCurrencyCents(item.discount_cents) : "—"`
- col6 total = `formatCurrencyCents(item.net_sales_cents ?? item.total_cents)`

Keep the deposit BS/PL/delivery affordance in the GL column unchanged.

- [ ] **Step 4: Add invoice-level discount + tax summary rows**

After the `.map(...)` over line items (after line ~172), render two summary rows spanning the grid, using `inv.discount_cents` and `inv.tax_cents`, only when non-zero:

```tsx
{(inv.discount_cents ?? 0) > 0 && (
  <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_50px_80px_70px_80px_minmax(0,1fr)] gap-3 px-10 py-1 text-[11px] text-secondary">
    <span className="col-span-5 text-right">Invoice discount</span>
    <span className="text-right font-mono tabular-nums">{formatCurrencyCents(inv.discount_cents!)}</span>
    <span />
  </div>
)}
{(inv.tax_cents ?? 0) > 0 && (
  <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_50px_80px_70px_80px_minmax(0,1fr)] gap-3 px-10 py-1 text-[11px] text-secondary">
    <span className="col-span-5 text-right">Tax</span>
    <span className="text-right font-mono tabular-nums">{formatCurrencyCents(inv.tax_cents!)}</span>
    <span />
  </div>
)}
```

- [ ] **Step 5: Verify in the browser preview**

Start the dev server and open Finance → Transactions → Invoices; expand an export invoice; confirm 7 columns, discount populated on a discounted line, and GL mapped. Use `preview_screenshot` to capture.

- [ ] **Step 6: Lint + commit**

Run: `npm run lint`

```bash
git add app/finance/transactions/invoices/page.tsx
git commit -m "feat(finance): 7-column invoice line view + discount/tax summary rows"
```

---

## Task 9: Backfill re-sync route

**Files:**
- Create: `app/api/finance/ledger/backfill-invoice-lines/route.ts`

**Interfaces:**
- Consumes: `syncSquareInvoicesForYear` from `@/lib/finance/syncSquareInvoices`.

- [ ] **Step 1: Implement an admin-guarded re-sync route**

```ts
// app/api/finance/ledger/backfill-invoice-lines/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole(["admin"]); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  // The year-sync already rewrites every Square invoice's line items via the shared mapper,
  // which covers export_invoice and allocation_deposit rows (both are source=square).
  const result = await syncSquareInvoicesForYear(supabase, year);
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/finance/ledger/backfill-invoice-lines/route.ts
git commit -m "feat(finance): admin backfill re-sync for export+deposit invoice lines"
```

> **Run against prod** only after Task 1's migration is applied. Verify one invoice (e.g. #000031) against Square before/after: discount recorded, net total correct, GL mapped.

---

## Task 10 (deferred): drop legacy catalog-ref columns

**Files:**
- Create: `supabase/migrations/20260711_drop_legacy_line_item_catalog_refs.sql`

Run **only after** the Task 9 backfill is verified in prod and no code references `square_variation_id` / `square_catalog_object_id`.

- [ ] **Step 1: Confirm no code references the legacy columns**

Run: `grep -rn "square_variation_id\|square_catalog_object_id" app lib --include=*.ts --include=*.tsx | grep -v "square_catalog_variation_id"`
Expected: no results (or only the migration files).

- [ ] **Step 2: Write the drop migration**

```sql
-- 20260711_drop_legacy_line_item_catalog_refs.sql
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS square_variation_id;
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS square_catalog_object_id;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260711_drop_legacy_line_item_catalog_refs.sql
git commit -m "chore(db): drop legacy invoice_line_items catalog-ref columns"
```

---

## Self-Review Notes

- **Spec §3.1 canonical columns** → Tasks 1, 2, 7, 8.
- **Spec §3.2 shared mapping** → Task 2; **§3.3 generate read-back** → Task 4; **§3.10 deposit** → Task 5.
- **Spec §3.4 auto-map** → Task 6.
- **Spec §3.5 invoice-level discount/tax rows** → Tasks 1 (`invoices.discount_cents`), 2 (`invoiceHeaderTotalsFromOrder`), 8 (summary rows).
- **Spec §3.6 schema** → Tasks 1, 10; **§3.7 backfill** → Task 9; **§3.8 display** → Tasks 7, 8.
- **Money semantics §4** → Task 2 (`net = gross − discount`, header from `total_money`), asserted by tests.
- **Consolidation mandate** → Tasks 4 + 5 share one mapper; Task 5 deletes the bespoke deposit insert.
- Type consistency: `CanonicalLineItemRow` field names match the DB columns added in Task 1 (`line_item_name`, `discount_cents`, `net_sales_cents`) and the select in Task 7 and render in Task 8.
