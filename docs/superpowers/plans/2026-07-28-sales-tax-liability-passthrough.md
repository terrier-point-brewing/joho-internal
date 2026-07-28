# Sales Tax as a Balance-Sheet Liability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop recognizing collected sales tax as P&L revenue; recognize it as a per-authority balance-sheet liability instead.

**Execution Budget:** Mode = subagent-driven-development (7 locality groups, ~21 files — above the 6-file inline tier). **Spawn cap = 9** (7 groups + 2). Token target ≈ 300k. The executor STOPS and reports before exceeding the spawn cap.

**Architecture:** The revenue correction is a **write-side** fix (`net_sales_cents` stops including tax) plus a backfill. The liability credit is **derived on read** in balance-sheet mode only, routed per `square_tax_id` through a user-configurable account map — no journal-entry machinery. Ordering between code deploy and data backfill is made irrelevant by rebasing the tax-filing base onto `gross − discount`, which is invariant under the backfill.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (PostgREST), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-sales-tax-liability-passthrough-design.md`

## Global Constraints

- Integer cents throughout. Never floats for money.
- Business logic lives in `lib/`, never in `app/api/**` route handlers.
- Every new or modified `lib/` module ships a co-located `*.test.ts`. `npm run verify` must pass.
- **Never apply migrations to prod.** The human does that after a backup.
- Supabase client per context: `lib/supabase/admin.ts` in route handlers/backfills, never the browser client.
- Page reads must page via `fetchAllRows` (`lib/supabase/paginate.ts`) — PostgREST silently truncates at 1000 rows.
- UI: no raw colors (`zinc/amber/red/green/blue/gray`), no hand-rolled primitives. Use token utilities and `app/components/ui/`.
- Two Square tax ids, fixed and verified in prod:
  - `ADD7EKQD2KN72NOYVUWHU34J` — "General Sales Tax", 7.25%, NC DOR
  - `ARI25PLSGLDVIBUQITKTRNSX` — "Prepared Food & Beverage Tax", 1%, Wake County
- Target CoA account names (exact strings):
  - `Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable`
  - `Sales & Excise Taxes Payable:Out Of Scope Agency Payable`

## Locality Groups → Spawns

| Group | Tasks | Files | Model |
|---|---|---|---|
| A — Migrations | 1 | `supabase/migrations/2026082{5,6}_*.sql` | Haiku |
| B — Sync writers | 2, 3 | `lib/finance/syncPosTransactions.ts` (+test) | Sonnet |
| C — Canonical invoice writer | 4 | `lib/finance/invoiceLineItems.ts` (+test) | Sonnet |
| D — Tax filing base | 5 | `lib/tax/squareTaxBase.ts` (+test) | Sonnet |
| E — Financials pipeline | 6, 7, 8 | `lib/finance/financials/*` | Sonnet |
| F — Settings | 9, 10 | `lib/finance/salesTaxAccounts.ts`, API route, page, nav | Sonnet |
| G — Backfill | 11, 12 | `lib/finance/backfillSalesTax.ts`, route | Sonnet |

Task order matters across groups: A → (B, C, D in any order) → E → F → G. G depends on C (uid fix) and A (tables).

---

### Task 1: Migrations

**Files:**
- Create: `supabase/migrations/20260825_square_tax_accounts.sql`
- Create: `supabase/migrations/20260826_invoice_line_item_taxes.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `square_tax_accounts` (pk `square_tax_id text`, `tax_name text`, `tax_pct numeric`, `chart_of_accounts_id uuid null`) and `invoice_line_item_taxes` (`id uuid pk`, `line_item_id uuid → invoice_line_items(id) on delete cascade`, `square_tax_id text not null`, `tax_name text`, `tax_pct numeric`, `amount_cents integer not null default 0`).

- [ ] **Step 1: Create the tax-account map migration**

Create `supabase/migrations/20260825_square_tax_accounts.sql`:

```sql
-- square_tax_accounts: maps each Square catalog tax to the balance-sheet
-- liability account its collections are credited to.
--
-- Sales tax collected from customers is money held for NC DOR / Wake County,
-- not revenue. Rows are seeded automatically from observed pos_line_item_taxes
-- /invoice_line_item_taxes by lib/finance/salesTaxAccounts.ts, so a new Square
-- tax surfaces in settings instead of being silently dropped.
--
-- Service-role-only access, matching the pos_line_item_taxes policy shape.

create table if not exists public.square_tax_accounts (
  square_tax_id        text        primary key,
  tax_name             text,
  tax_pct              numeric,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.square_tax_accounts.chart_of_accounts_id is
  'Other Current Liabilities account credited on collection; NULL = unmapped, emits no accrual';
comment on column public.square_tax_accounts.tax_name is
  'Last-seen Square label, display only -- the map keys on square_tax_id';

-- Seed the two taxes observed in prod. The scalar subquery yields NULL when the
-- account name does not match, leaving the row unmapped (safe: no accrual) --
-- deliberately NOT a hard failure, which would block the whole migration.
insert into public.square_tax_accounts (square_tax_id, tax_name, tax_pct, chart_of_accounts_id)
values
  ('ADD7EKQD2KN72NOYVUWHU34J', 'General Sales Tax', 7.25,
   (select id from public.chart_of_accounts
     where account_name = 'Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable'
     limit 1)),
  ('ARI25PLSGLDVIBUQITKTRNSX', 'Prepared Food & Beverage Tax', 1,
   (select id from public.chart_of_accounts
     where account_name = 'Sales & Excise Taxes Payable:Out Of Scope Agency Payable'
     limit 1))
on conflict (square_tax_id) do nothing;

alter table public.square_tax_accounts enable row level security;

create policy "finance readers" on public.square_tax_accounts
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );
```

- [ ] **Step 2: Create the invoice tax mirror migration**

Create `supabase/migrations/20260826_invoice_line_item_taxes.sql`:

```sql
-- invoice_line_item_taxes: per-line Square tax breakdown for invoice-backed
-- orders. Structurally identical to pos_line_item_taxes (20260711), one table
-- over, so fetchTaxableBase and fetchTaxAccruals each union two sources of one
-- row shape instead of growing a second code path.
--
-- Needed because invoice_line_items stores only a scalar tax_cents with no
-- authority attribution, so invoice-collected tax was invisible to the NC DOR
-- worksheets.

create table if not exists public.invoice_line_item_taxes (
  id            uuid        primary key default gen_random_uuid(),
  line_item_id  uuid        not null references public.invoice_line_items(id) on delete cascade,
  square_tax_id text        not null,
  tax_name      text,
  tax_pct       numeric,
  amount_cents  integer     not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists invoice_line_item_taxes_line_item_id_idx
  on public.invoice_line_item_taxes (line_item_id);

create index if not exists invoice_line_item_taxes_square_tax_id_idx
  on public.invoice_line_item_taxes (square_tax_id);

comment on column public.invoice_line_item_taxes.amount_cents is 'tax applied to this line by this tax, in cents';

alter table public.invoice_line_item_taxes enable row level security;

create policy "finance readers" on public.invoice_line_item_taxes
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );
```

- [ ] **Step 3: Confirm no prefix collision**

Run: `ls supabase/migrations | sort | tail -4`
Expected: `20260823_payroll_tips_account.sql`, `20260824_payroll_gl_bucket_kind.sql`, `20260825_square_tax_accounts.sql`, `20260826_invoice_line_item_taxes.sql` — each prefix appearing exactly once.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260825_square_tax_accounts.sql supabase/migrations/20260826_invoice_line_item_taxes.sql
git commit -m "feat(finance): add square_tax_accounts map and invoice_line_item_taxes"
```

---

### Task 2: Correct the test fixture, then make POS line writes tax-free

The shared `order` fixture in `syncPosTransactions.test.ts` sets line `total_money: 1350` with `gross 1400 / discount 50 / tax 100` — that is `gross − discount`, i.e. tax-**exclusive**. Prod is the opposite. Because the fixture is unrealistic, the current assertion `net_sales_cents: 1350` passes under both the buggy and the fixed implementation. Fix the fixture first so the test can actually see the bug.

**Files:**
- Modify: `lib/finance/syncPosTransactions.test.ts:14-39` (fixture), `:122-147` (`buildPosLineItems` tests)
- Modify: `lib/finance/syncPosTransactions.ts:113-137` (`buildPosLineItems`)

**Interfaces:**
- Consumes: nothing.
- Produces: `buildPosLineItems(orderDbId: string, order: Order, getPosCoA: (variationId: string) => string | null)` — unchanged signature; `net_sales_cents` now equals `gross_sales_money − total_discount_money`.

- [ ] **Step 1: Make the fixture prod-realistic**

In `lib/finance/syncPosTransactions.test.ts`, change the shared `order` fixture's line item so `total_money` is tax-inclusive. Change ONLY the line item's `total_money` (leave the order-level `total_money: 1200` alone — it is unrelated to this identity and other tests assert on it):

```ts
      base_price_money: { amount: 700, currency: "USD" },
      gross_sales_money: { amount: 1400, currency: "USD" },
      total_discount_money: { amount: 50, currency: "USD" },
      total_tax_money: { amount: 100, currency: "USD" },
      // Prod identity: line total_money = gross - discount + tax (1400-50+100).
      // Verified against square_orders.raw_data for both POS and invoice orders.
      total_money: { amount: 1450, currency: "USD" },
```

- [ ] **Step 2: Run the suite to watch it fail**

Run: `npx vitest run lib/finance/syncPosTransactions.test.ts`
Expected: FAIL. `buildPosLineItems` "builds POS rows with resolved CoA and numeric quantity" reports `net_sales_cents: 1450` received vs `1350` expected. `buildInvoiceLineItems` "builds invoice rows..." reports `total_cents: 1450` / `net_sales_cents: 1450` vs `1350` expected. These two failures ARE the bug.

- [ ] **Step 3: Add an explicit regression test**

Append to the `describe("buildPosLineItems", ...)` block in `lib/finance/syncPosTransactions.test.ts`:

```ts
  it("excludes tax from net_sales_cents (sales tax is a liability, not revenue)", () => {
    const items = buildPosLineItems("DBID_1", order, () => null);
    // gross 1400 - discount 50 = 1350; the line's 100c of tax must NOT be here.
    expect(items[0].net_sales_cents).toBe(1350);
    expect(items[0].tax_cents).toBe(100);
    expect(items[0].net_sales_cents + items[0].tax_cents).toBe(
      order.line_items![0].total_money!.amount,
    );
  });
```

- [ ] **Step 4: Make `buildPosLineItems` tax-free**

In `lib/finance/syncPosTransactions.ts`, inside `buildPosLineItems`'s returned object, replace the `net_sales_cents` line:

```ts
      gross_sales_cents: li.gross_sales_money?.amount ?? 0,
      discount_cents: li.total_discount_money?.amount ?? 0,
      // Square's line `total_money` is gross - discount + TAX. Sales tax is
      // money held for NC DOR / Wake County, not revenue, so net sales is
      // gross - discount and the tax is carried separately in tax_cents.
      // fetchPos maps this column straight onto P&L revenue.
      net_sales_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
      tax_cents: li.total_tax_money?.amount ?? 0,
```

- [ ] **Step 5: Run the POS tests to verify they pass**

Run: `npx vitest run lib/finance/syncPosTransactions.test.ts -t "buildPosLineItems"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/finance/syncPosTransactions.ts lib/finance/syncPosTransactions.test.ts
git commit -m "fix(finance): exclude sales tax from pos_line_items.net_sales_cents"
```

---

### Task 3: Make invoice line writes tax-free and emit invoice tax rows

`buildInvoiceLineItems` (the invoice-backed-order path in the same file) writes `total_cents: li.total_money` — tax-inclusive, contradicting the canonical builder. It is also the natural place to emit `invoice_line_item_taxes`.

**Files:**
- Modify: `lib/finance/syncPosTransactions.ts:139-177` (`buildLineItemTaxRows`), `:181-205` (`buildInvoiceLineItems`), `:280-340` (insert block)
- Modify: `lib/finance/syncPosTransactions.test.ts` (`buildInvoiceLineItems` + `buildLineItemTaxRows` blocks)

**Interfaces:**
- Consumes: `buildPosLineItems` from Task 2 (unchanged signature).
- Produces:
  - `buildInvoiceLineItems(invoiceId, order, getInvoiceCoA)` — `total_cents` and `net_sales_cents` now `gross − discount`.
  - `buildLineItemTaxRows(order: Order, lineItemDbIdByUid: Map<string, string>): LineItemTaxRow[]` — renamed row type, otherwise identical behavior; serves both `pos_line_item_taxes` and `invoice_line_item_taxes`.
  - `export interface LineItemTaxRow { line_item_id: string; square_tax_id: string; tax_name: string | null; tax_pct: number | null; amount_cents: number }` (replaces `PosLineItemTaxRow`; keep `export type PosLineItemTaxRow = LineItemTaxRow` as an alias so existing importers keep compiling).

- [ ] **Step 1: Write the failing tests**

Replace the `describe("buildInvoiceLineItems", ...)` block in `lib/finance/syncPosTransactions.test.ts` with:

```ts
describe("buildInvoiceLineItems", () => {
  it("builds invoice rows with a 1-based sort order and joined description", () => {
    const items = buildInvoiceLineItems("INV_1", order, () => "COA_INV");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      invoice_id: "INV_1",
      sort_order: 1,
      description: "Hazy IPA – Pint",
      quantity: 2,
      unit_price_cents: 700,
      total_cents: 1350,
      gross_sales_cents: 1400,
      net_sales_cents: 1350,
      square_catalog_variation_id: "VAR_A",
      chart_of_accounts_id: "COA_INV",
    });
  });

  it("excludes tax from total_cents and net_sales_cents", () => {
    const items = buildInvoiceLineItems("INV_1", order, () => null);
    // Square line total_money is 1450 (tax-inclusive); revenue is 1400-50.
    expect(items[0].total_cents).toBe(1350);
    expect(items[0].net_sales_cents).toBe(1350);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/syncPosTransactions.test.ts -t "buildInvoiceLineItems"`
Expected: FAIL — both tests report `1450` where `1350` is expected.

- [ ] **Step 3: Make `buildInvoiceLineItems` tax-free**

In `lib/finance/syncPosTransactions.ts`, in `buildInvoiceLineItems`'s returned object:

```ts
      quantity: parseFloat(li.quantity ?? "1"),
      unit_price_cents: li.base_price_money?.amount ?? 0,
      // Tax-free, matching lib/finance/invoiceLineItems.ts's canonical builder.
      // Square's line `total_money` includes tax on invoice orders too
      // (verified in raw_data: 10000 - 724 + 673 = 9949).
      total_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
      gross_sales_cents: li.gross_sales_money?.amount ?? 0,
      discount_cents: li.total_discount_money?.amount ?? 0,
      net_sales_cents: (li.gross_sales_money?.amount ?? 0) - (li.total_discount_money?.amount ?? 0),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/finance/syncPosTransactions.test.ts -t "buildInvoiceLineItems"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Rename the tax row type to be table-agnostic**

In `lib/finance/syncPosTransactions.ts`, replace the `PosLineItemTaxRow` interface and the `buildLineItemTaxRows` doc comment:

```ts
/**
 * One row for `pos_line_item_taxes` OR `invoice_line_item_taxes` — the two
 * tables are structurally identical, so one builder serves both. The caller
 * decides which table to insert into by which db-id map it passes.
 */
export interface LineItemTaxRow {
  line_item_id: string;
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  amount_cents: number;
}

/** @deprecated Use LineItemTaxRow. Kept so existing importers keep compiling. */
export type PosLineItemTaxRow = LineItemTaxRow;
```

Then change `buildLineItemTaxRows`'s return type annotation from `PosLineItemTaxRow[]` to `LineItemTaxRow[]` and its internal `const rows: PosLineItemTaxRow[] = []` to `const rows: LineItemTaxRow[] = []`. **Do not change its logic** — resolving `applied_taxes[].tax_uid` against `order.taxes[]` is already table-agnostic.

- [ ] **Step 6: Carry the order alongside the queued invoice items**

`invoiceLineItemsToInsert` currently holds only `{ invoiceId, items }`, but building tax rows needs the `Order`. In `lib/finance/syncPosTransactions.ts`, change the declaration (currently `const invoiceLineItemsToInsert: { invoiceId: string; items: object[] }[] = [];`):

```ts
  const invoiceLineItemsToInsert: { invoiceId: string; items: object[]; order: Order }[] = [];
```

and add `order` to both push sites — the cancel branch:

```ts
      if (invoiceId) invoiceLineItemsToInsert.push({ invoiceId, items: [], order });
```

and the sync branch:

```ts
      invoiceLineItemsToInsert.push({
        invoiceId,
        items: buildInvoiceLineItems(invoiceId, order, getInvoiceCoA),
        order,
      });
```

- [ ] **Step 7: Insert invoice tax rows during sync**

Replace the existing invoice-line-item insert loop in `lib/finance/syncPosTransactions.ts`:

```ts
  for (const { invoiceId, items } of invoiceLineItemsToInsert) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const { error } = await supabase.from("invoice_line_items").insert(items.slice(i, i + BATCH_SIZE));
      if (error) errors.push(`Invoice line items (${invoiceId}) batch ${i}: ${error.message}`);
    }
  }
```

with:

```ts
  for (const { invoiceId, items, order } of invoiceLineItemsToInsert) {
    // The delete cascades to invoice_line_item_taxes (ON DELETE CASCADE), so a
    // re-sync converges without a separate tax-row cleanup.
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);

    // Select the server-generated ids back, keyed by square_line_item_uid, the
    // same way the POS path does -- that map is what buildLineItemTaxRows needs.
    const uidMap = new Map<string, string>();
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const { data, error } = await supabase
        .from("invoice_line_items")
        .insert(items.slice(i, i + BATCH_SIZE))
        .select("id, square_line_item_uid");
      if (error) {
        errors.push(`Invoice line items (${invoiceId}) batch ${i}: ${error.message}`);
        continue;
      }
      for (const row of (data ?? []) as { id: string; square_line_item_uid: string | null }[]) {
        if (row.square_line_item_uid) uidMap.set(row.square_line_item_uid, row.id);
      }
    }
    if (uidMap.size === 0) continue;

    const invoiceTaxRows = buildLineItemTaxRows(order, uidMap);
    for (let i = 0; i < invoiceTaxRows.length; i += BATCH_SIZE) {
      const { error } = await supabase
        .from("invoice_line_item_taxes")
        .insert(invoiceTaxRows.slice(i, i + BATCH_SIZE));
      if (error) errors.push(`Invoice line item taxes (${invoiceId}) batch ${i}: ${error.message}`);
    }
  }
```

- [ ] **Step 8: Run the full file's tests**

Run: `npx vitest run lib/finance/syncPosTransactions.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `PosLineItemTaxRow` importers break, the alias in Step 5 was omitted.

- [ ] **Step 10: Commit**

```bash
git add lib/finance/syncPosTransactions.ts lib/finance/syncPosTransactions.test.ts
git commit -m "fix(finance): tax-free invoice line totals + emit invoice_line_item_taxes"
```

---

### Task 4: Fix the corrupt `square_line_item_uid` at the source

60 of 64 populated `invoice_line_items.square_line_item_uid` values point at the wrong Square line. `persistInvoiceLineItems` upserts on `(invoice_id, sort_order)` and `square_line_item_uid` is not in `CanonicalLineItemRow`, so a stale 1-based uid survives under a 0-based canonical row. Putting the column in the canonical row makes it correct by construction and self-healing on every re-sync.

**Files:**
- Modify: `lib/finance/invoiceLineItems.ts:33-50` (`CanonicalLineItemRow`), `:130-147` (the `rows.push`)
- Test: `lib/finance/invoiceLineItems.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CanonicalLineItemRow` gains `square_line_item_uid: string | null`. `buildInvoiceLineItemRows(invoiceId, order, indexes, existingCoaBySort)` — unchanged signature, now emits the uid aligned to its own `sort_order`.

- [ ] **Step 1: Write the failing test**

Add to `lib/finance/invoiceLineItems.test.ts` (import `buildInvoiceLineItemRows` and the `LineItemIndexes` shape the file's existing tests already build; reuse whatever local helper those tests use to construct `indexes`, and if none exists construct it inline as below):

```ts
  it("aligns square_line_item_uid with sort_order across a skipped excise line", () => {
    const indexes = {
      kegIndex: new Map(),
      canVariationOz: new Map(),
      variationById: new Map(),
      itemNameByVariationId: new Map(),
    } as unknown as LineItemIndexes;

    const order = {
      id: "O1",
      discounts: [{ name: "Excise carve out", applied_money: { amount: 500 } }],
      line_items: [
        { uid: "u-a", name: "Packaging Fee", quantity: "1",
          base_price_money: { amount: 100 }, gross_sales_money: { amount: 100 },
          total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
        // Skipped: carve-out excise line, matched on gross === 500.
        { uid: "u-excise", name: "Barrel Excise Tax", quantity: "1",
          base_price_money: { amount: 500 }, gross_sales_money: { amount: 500 },
          total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
        { uid: "u-c", name: "CO2 Refill", quantity: "1",
          base_price_money: { amount: 900 }, gross_sales_money: { amount: 900 },
          total_discount_money: { amount: 0 }, total_tax_money: { amount: 65 } },
      ],
    } as unknown as Order;

    const rows = buildInvoiceLineItemRows("INV_1", order, indexes, new Map());

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sort_order: 0, square_line_item_uid: "u-a" });
    // The excise line is skipped WITHOUT advancing sort_order, so row 1 must
    // carry u-c -- not u-excise. This is the off-by-one that corrupted 60 rows.
    expect(rows[1]).toMatchObject({ sort_order: 1, square_line_item_uid: "u-c", tax_cents: 65 });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/invoiceLineItems.test.ts -t "aligns square_line_item_uid"`
Expected: FAIL — `square_line_item_uid` is `undefined`, because `CanonicalLineItemRow` has no such field.

- [ ] **Step 3: Add the field to the type**

In `lib/finance/invoiceLineItems.ts`, add to `CanonicalLineItemRow` after `square_catalog_variation_id`:

```ts
  square_catalog_variation_id: string | null;
  /**
   * Square's per-line uid. MUST be written here rather than left to
   * syncPosTransactions.ts's buildInvoiceLineItems: persistInvoiceLineItems
   * upserts on (invoice_id, sort_order), so a column absent from this type is
   * never overwritten. That let a 1-based uid from the other writer survive
   * under this builder's 0-based, excise-skipping sort_order -- corrupting 60
   * of 64 populated uids before this fix.
   */
  square_line_item_uid: string | null;
  chart_of_accounts_id: string | null;
```

- [ ] **Step 4: Populate it in the builder**

In `lib/finance/invoiceLineItems.ts`, inside `buildInvoiceLineItemRows`'s `rows.push({...})`, add alongside `square_catalog_variation_id`:

```ts
      square_catalog_variation_id: varId || null,
      square_line_item_uid: li.uid ?? null,
      chart_of_accounts_id: coa.chart_of_accounts_id,
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/finance/invoiceLineItems.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Any other construction site of `CanonicalLineItemRow` must now supply `square_line_item_uid`.

- [ ] **Step 7: Commit**

```bash
git add lib/finance/invoiceLineItems.ts lib/finance/invoiceLineItems.test.ts
git commit -m "fix(finance): write square_line_item_uid from the canonical invoice builder"
```

---

### Task 5: Rebase the tax filing base onto `gross − discount`

`fetchTaxableBase` computes `net_sales_cents − tax_cents`. Once Task 2 lands, that under-reports the base by the tax amount for every backfilled row. `gross_sales_cents − discount_cents` is identical before and after the backfill, so ordering between deploy and backfill stops mattering.

**Files:**
- Modify: `lib/tax/squareTaxBase.ts:23-30` (row type), `:41-67` (query + sum)
- Modify: `lib/tax/squareTaxBase.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchTaxableBase(sb, squareTaxId, period, pageSize?): Promise<{ baseCents: number; collectedCents: number }>` — unchanged signature and unchanged outputs; internals rebased and the invoice source unioned in.

**Equivalence gate:** every `expect(...)` value in the existing tests stays byte-identical. Only fixtures gain columns. If an expected value has to move, STOP and report — the rebase is not equivalent.

- [ ] **Step 1: Extend the fixtures to satisfy the identity, keeping expectations identical**

In `lib/tax/squareTaxBase.test.ts`, change the `TaxRow` interface and every fixture row so `gross − discount == net − tax`. Expectations are untouched:

```ts
interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: {
    net_sales_cents: number;
    tax_cents: number;
    gross_sales_cents: number;
    discount_cents: number;
  };
}
```

First test's rows (`net 10000 / tax 725` → base 9275; `net 5000 / tax 363` → base 4637):

```ts
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725, gross_sales_cents: 9275, discount_cents: 0 } },
      { line_item_id: "B", amount_cents: 363, pos_line_items: { net_sales_cents: 5000, tax_cents: 363, gross_sales_cents: 4637, discount_cents: 0 } },
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725, gross_sales_cents: 9275, discount_cents: 0 } },
    ];
```

Second test's rows:

```ts
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 100, pos_line_items: { net_sales_cents: 1000, tax_cents: 100, gross_sales_cents: 900, discount_cents: 0 } },
      { line_item_id: "B", amount_cents: 200, pos_line_items: { net_sales_cents: 2000, tax_cents: 200, gross_sales_cents: 1800, discount_cents: 0 } },
      { line_item_id: "C", amount_cents: 300, pos_line_items: { net_sales_cents: 3000, tax_cents: 300, gross_sales_cents: 2700, discount_cents: 0 } },
    ];
```

Also relax the stub's table guard so the new invoice query is routed rather than throwing — replace the `if (table !== "pos_line_item_taxes") throw ...` line with:

```ts
    if (table !== "pos_line_item_taxes" && table !== "invoice_line_item_taxes") {
      throw new Error(`unexpected table: ${table}`);
    }
    // The invoice source contributes nothing in these fixtures.
    if (table === "invoice_line_item_taxes") {
      const empty: Record<string, unknown> = {};
      empty.select = () => empty;
      empty.eq = () => empty;
      empty.neq = () => empty;   // the invoice query filters out voided invoices
      empty.gte = () => empty;
      empty.lt = () => empty;
      empty.lte = () => empty;
      empty.order = () => empty;
      empty.range = () => Promise.resolve({ data: [], error: null });
      return empty;
    }
```

- [ ] **Step 2: Run to confirm the gate is green before the change**

Run: `npx vitest run lib/tax/squareTaxBase.test.ts`
Expected: PASS, 4 tests. (Fixtures now carry redundant-but-consistent columns; the implementation still reads `net − tax`.)

- [ ] **Step 3: Rebase the computation and union the invoice source**

Replace `lib/tax/squareTaxBase.ts`'s row interface and `fetchTaxableBase` body:

```ts
interface TaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  pos_line_items:
    | { gross_sales_cents: number | null; discount_cents: number | null }
    | { gross_sales_cents: number | null; discount_cents: number | null }[]
    | null;
}

interface InvoiceTaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  invoice_line_items:
    | { gross_sales_cents: number | null; discount_cents: number | null }
    | { gross_sales_cents: number | null; discount_cents: number | null }[]
    | null;
}

export async function fetchTaxableBase(
  sb: SupabaseClient,
  squareTaxId: string,
  period: TaxPeriod,
  pageSize?: number,
): Promise<{ baseCents: number; collectedCents: number }> {
  const startTs = `${period.start}T00:00:00Z`;
  const endExclusiveTs = `${addDaysStr(period.end, 1)}T00:00:00Z`;

  const posRows = await fetchAllRows<TaxJoinRow>(
    () =>
      sb
        .from("pos_line_item_taxes")
        .select(
          "line_item_id, amount_cents, pos_line_items!inner ( gross_sales_cents, discount_cents, square_orders!inner ( transaction_date ) )",
        )
        .eq("square_tax_id", squareTaxId)
        .gte("pos_line_items.square_orders.transaction_date", startTs)
        .lt("pos_line_items.square_orders.transaction_date", endExclusiveTs)
        .order("line_item_id", { ascending: true }),
    pageSize,
  );

  // Invoice-collected tax lives in a mirror table (migration 20260826). It is
  // wrapped because an unapplied migration must degrade to "no invoice tax"
  // rather than failing a filing worksheet outright. The POS source above is
  // deliberately NOT wrapped: that table exists, and a silent zero there would
  // corrupt the return.
  let invoiceRows: InvoiceTaxJoinRow[] = [];
  try {
    invoiceRows = await fetchAllRows<InvoiceTaxJoinRow>(
      () =>
        sb
          .from("invoice_line_item_taxes")
          .select(
            "line_item_id, amount_cents, invoice_line_items!inner ( gross_sales_cents, discount_cents, invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status ) )",
          )
          .eq("square_tax_id", squareTaxId)
          .neq("invoice_line_items.invoices.status", "voided")
          .gte("invoice_line_items.invoices.invoice_date", period.start)
          .lte("invoice_line_items.invoices.invoice_date", period.end)
          .order("line_item_id", { ascending: true }),
      pageSize,
    );
  } catch {
    invoiceRows = [];
  }

  const seen = new Set<string>();
  let baseCents = 0;
  let collectedCents = 0;

  // base = gross_sales_cents - discount_cents (post-discount, pre-tax
  // receipts). Deliberately NOT net_sales_cents - tax_cents: net_sales_cents
  // changes meaning when the sales-tax backfill runs, whereas gross/discount
  // do not, so this form is correct both before and after it.
  const add = (
    key: string,
    amount: number | null,
    parentRaw:
      | { gross_sales_cents: number | null; discount_cents: number | null }
      | { gross_sales_cents: number | null; discount_cents: number | null }[]
      | null,
  ) => {
    if (seen.has(key)) return;
    seen.add(key);
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    if (!parent) return;
    baseCents += num(parent.gross_sales_cents) - num(parent.discount_cents);
    collectedCents += num(amount);
  };

  for (const row of posRows) add(`p:${row.line_item_id}`, row.amount_cents, row.pos_line_items);
  for (const row of invoiceRows) add(`i:${row.line_item_id}`, row.amount_cents, row.invoice_line_items);

  return { baseCents, collectedCents };
}
```

Update the module's header comment: replace the sentence beginning "Filtering to one tax id yields..." with:

```
 * Filtering to one tax id yields exactly one tax row per qualifying line, so a
 * single pass gives per line: base = gross_sales_cents - discount_cents
 * (post-discount, pre-tax receipts), collected = amount_cents. Dedupes by
 * line_item_id, namespaced per source since the two tables' ids are unrelated.
 * Paged via fetchAllRows to dodge PostgREST's 1000-row cap. pageSize is
 * injectable for tests only.
```

- [ ] **Step 4: Run the gate**

Run: `npx vitest run lib/tax/squareTaxBase.test.ts`
Expected: PASS, 4 tests, **with no expected value edited**. If any assertion needed changing, STOP and report.

- [ ] **Step 5: Add an invoice-source test**

Append to `describe("fetchTaxableBase", ...)`:

```ts
  it("unions invoice-collected tax into base and collected", async () => {
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.neq = () => b;
      b.gte = () => b; b.lt = () => b; b.lte = () => b; b.order = () => b;
      b.range = (f: number, t: number) => {
        const rows = table === "pos_line_item_taxes"
          ? [{ line_item_id: "P1", amount_cents: 725, pos_line_items: { gross_sales_cents: 9275, discount_cents: 0 } }]
          : [{ line_item_id: "I1", amount_cents: 673, invoice_line_items: { gross_sales_cents: 10000, discount_cents: 724 } }];
        return Promise.resolve({ data: rows.slice(f, t + 1), error: null });
      };
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    const res = await fetchTaxableBase(sb, "TAX_GEN", period);
    expect(res.baseCents).toBe(9275 + (10000 - 724));
    expect(res.collectedCents).toBe(725 + 673);
  });

  it("degrades to POS-only when the invoice tax table is missing", async () => {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes") throw new Error('relation "invoice_line_item_taxes" does not exist');
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.gte = () => b; b.lt = () => b; b.order = () => b;
      b.range = (f: number, t: number) =>
        Promise.resolve({ data: [{ line_item_id: "P1", amount_cents: 725, pos_line_items: { gross_sales_cents: 9275, discount_cents: 0 } }].slice(f, t + 1), error: null });
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    const res = await fetchTaxableBase(sb, "TAX_GEN", period);
    expect(res).toEqual({ baseCents: 9275, collectedCents: 725 });
  });
```

- [ ] **Step 6: Run**

Run: `npx vitest run lib/tax/squareTaxBase.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add lib/tax/squareTaxBase.ts lib/tax/squareTaxBase.test.ts
git commit -m "fix(tax): base taxable receipts on gross-discount and union invoice tax"
```

---

### Task 6: Add the `tax_accrual` source to the sign + aggregation layer

**Files:**
- Modify: `lib/finance/financials/normalizeSign.ts:47-51` (signature)
- Modify: `lib/finance/financials/aggregateRows.ts:116-151` (types), `:305-320` (resolver), `:385-390` (loop)
- Modify: `lib/finance/financials/normalizeSign.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeSignedCents(rawCents, statementSection, source)` where `source` gains `"tax_accrual"`.
  - `export interface TaxAccrualRecord { id: string; chartOfAccountsId: string; amountCents: number; monthKey: string }` in `aggregateRows.ts`.
  - `AggregateInput` gains `taxAccruals: TaxAccrualRecord[]`.

- [ ] **Step 1: Write the failing sign test**

Append to `lib/finance/financials/normalizeSign.test.ts`:

```ts
  it("signs tax_accrual negative on a liability section (collected tax = we owe more)", () => {
    expect(normalizeSignedCents(288732, "other_current_liabilities", "tax_accrual")).toBe(-288732);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/financials/normalizeSign.test.ts`
Expected: FAIL — TypeScript rejects `"tax_accrual"` as not assignable to the `source` parameter type.

- [ ] **Step 3: Widen the signature**

In `lib/finance/financials/normalizeSign.ts`, change the `source` parameter type:

```ts
  source: "pos" | "invoice" | "expense" | "bank" | "refund" | "tip_accrual" | "tax_accrual"
```

No other change: `tax_accrual` falls through to the pos/invoice branch, where `other_current_liabilities ∈ NEGATIVE_SECTIONS` yields `-magnitude`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/finance/financials/normalizeSign.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Add the record type and union member in aggregateRows**

In `lib/finance/financials/aggregateRows.ts`, add after `TipAccrualRecord`:

```ts
/** One month's collected sales tax for ONE liability account, derived on read. */
export interface TaxAccrualRecord {
  /** Synthetic, e.g. `tax-<coaId>-2026-07`. */
  id: string;
  chartOfAccountsId: string;
  /** Positive magnitude of tax collected. */
  amountCents: number;
  /** "YYYY-MM", already canonical -- balance-sheet mode collapses everything onto one synthetic month key. */
  monthKey: string;
}
```

Add to `AggregateInput` beside `tipAccruals`:

```ts
  tipAccruals: TipAccrualRecord[];
  taxAccruals: TaxAccrualRecord[];
```

Widen the source union:

```ts
type NormalizeSource = "pos" | "invoice" | "expense" | "bank" | "refund" | "tip_accrual" | "tax_accrual";
```

- [ ] **Step 6: Add the resolver and the loop**

In `lib/finance/financials/aggregateRows.ts`, add after `resolveTipAccrual`:

```ts
function resolveTaxAccrual(row: TaxAccrualRecord, coaMap: Map<string, CoaRecord>): ResolvedRow {
  const section = coaSection(coaMap.get(row.chartOfAccountsId));
  return {
    table: "pos_line_item_taxes",
    id: row.id,
    coaId: row.chartOfAccountsId,
    mappingSource: "rule",
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCents: normalizeSignedCents(row.amountCents, section, "tax_accrual"),
    bbl: 0,
    bblCoverage: "full",
    monthKey: row.monthKey,
  };
}
```

And immediately after the existing `for (const row of input.tipAccruals) { ... }` loop:

```ts
  for (const row of input.taxAccruals) {
    const r = resolveTaxAccrual(row, coaMap);
    if (monthSet.has(r.monthKey)) resolved.push(r);
  }
```

- [ ] **Step 7: Add an aggregation test**

Append to `lib/finance/financials/aggregateRows.test.ts` a case inside the existing top-level `describe`. Match the surrounding tests' input-construction style; the shape is:

```ts
  it("posts a tax accrual negative onto its liability account", () => {
    const rows = aggregateRows({
      pos: [], invoiceLines: [], expenses: [], refunds: [], bank: [], tipAccruals: [],
      taxAccruals: [{ id: "tax-COA_TAX-2026-07", chartOfAccountsId: "COA_TAX", amountCents: 288732, monthKey: "2026-07" }],
      coa: [{ id: "COA_TAX", parentId: null, accountName: "Sales & Excise Taxes Payable:Sales Tax Payable", accountNumber: null, accountType: "Other Current Liabilities", statementSection: null }],
      months: ["2026-07"],
    });
    const row = rows.find((r) => r.coaId === "COA_TAX");
    expect(row?.amountCentsByMonth["2026-07"]).toBe(-288732);
    expect(row?.statementSection).toBe("other_current_liabilities");
  });
```

- [ ] **Step 8: Fix every existing `aggregateRows` caller and test**

`AggregateInput` now requires `taxAccruals`. Run: `npx tsc --noEmit`
Expected: errors at each `aggregateRows({...})` call site missing the field. Add `taxAccruals: []` to every existing test-input object in `aggregateRows.test.ts`, `volume.test.ts`, and any other caller the compiler flags. `buildFinancials.ts` is handled in Task 8.

- [ ] **Step 9: Run**

Run: `npx vitest run lib/finance/financials/`
Expected: PASS (except `buildFinancials.test.ts`, which Task 8 wires; if it fails only on a missing `taxAccruals` in a mocked `fetchFinancialsSources` return, add `taxAccruals: []` there too).

- [ ] **Step 10: Commit**

```bash
git add lib/finance/financials/normalizeSign.ts lib/finance/financials/normalizeSign.test.ts lib/finance/financials/aggregateRows.ts lib/finance/financials/aggregateRows.test.ts lib/finance/financials/volume.test.ts
git commit -m "feat(finance): add tax_accrual source to the financials sign + aggregation layer"
```

---

### Task 7: Fetch the tax-account map and the collection accrual

**Files:**
- Modify: `lib/finance/financials/fetchSources.ts` (add `fetchTaxAccountMap`, `fetchTaxAccruals`, result field, `Promise.all` wiring)
- Modify: `lib/finance/financials/fetchSources.test.ts`

**Interfaces:**
- Consumes: `TaxAccrualRecord` from Task 6.
- Produces:
  - `fetchTaxAccountMap(supabase): Promise<Map<string, string>>` — `square_tax_id → chart_of_accounts_id`, omitting unmapped rows; `new Map()` on ANY error.
  - `fetchTaxAccruals(supabase, range, accountByTaxId): Promise<TaxAccrualRecord[]>` — exported for tests.
  - `FinancialsSourcesResult` gains `taxAccruals: TaxAccrualRecord[]`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/finance/financials/fetchSources.test.ts` (import `fetchTaxAccruals` from `./fetchSources`):

```ts
describe("fetchTaxAccruals", () => {
  const range = { startDateStr: null, start: null, endDateStr: "2026-07-31", end: "2026-08-01T00:00:00Z" };

  function stub(posRows: unknown[], invRows: unknown[], invThrows = false) {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes" && invThrows) throw new Error("missing relation");
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.neq = () => b;
      b.gte = () => b; b.lt = () => b; b.lte = () => b; b.order = () => b;
      b.range = (f: number, t: number) => {
        const rows = table === "pos_line_item_taxes" ? posRows : invRows;
        return Promise.resolve({ data: rows.slice(f, t + 1), error: null });
      };
      return b;
    };
    return { from } as unknown as SupabaseClient;
  }

  const posRow = (id: string, taxId: string, cents: number) => ({
    line_item_id: id, square_tax_id: taxId, amount_cents: cents,
  });

  it("groups by square_tax_id, resolves accounts, and keys the canonical month", async () => {
    const sb = stub(
      [posRow("a", "TAX_GEN", 103243), posRow("b", "TAX_PFB", 8644), posRow("c", "TAX_GEN", 98095)],
      [],
    );
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_NCDOR"], ["TAX_PFB", "COA_WAKE"]]));
    expect(res).toEqual([
      { id: "tax-COA_NCDOR-2026-07", chartOfAccountsId: "COA_NCDOR", amountCents: 201338, monthKey: "2026-07" },
      { id: "tax-COA_WAKE-2026-07", chartOfAccountsId: "COA_WAKE", amountCents: 8644, monthKey: "2026-07" },
    ]);
  });

  it("merges two taxes that point at the same account", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 100), posRow("b", "TAX_PFB", 25)], []);
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"], ["TAX_PFB", "COA_X"]]));
    expect(res).toEqual([{ id: "tax-COA_X-2026-07", chartOfAccountsId: "COA_X", amountCents: 125, monthKey: "2026-07" }]);
  });

  it("emits nothing for an unmapped tax", async () => {
    const sb = stub([posRow("a", "TAX_UNKNOWN", 500)], []);
    // Non-empty map on purpose: an empty map short-circuits before the
    // per-row mapping filter, so it would pass for the wrong reason.
    expect(await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]))).toEqual([]);
  });

  it("emits nothing when no tax is mapped at all", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 500)], []);
    expect(await fetchTaxAccruals(sb, range, new Map())).toEqual([]);
  });

  it("skips an account whose total is <= 0", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 0)], []);
    expect(await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]))).toEqual([]);
  });

  it("degrades to POS-only when the invoice tax table is missing", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 700)], [], true);
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]));
    expect(res).toEqual([{ id: "tax-COA_X-2026-07", chartOfAccountsId: "COA_X", amountCents: 700, monthKey: "2026-07" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/financials/fetchSources.test.ts -t "fetchTaxAccruals"`
Expected: FAIL — `fetchTaxAccruals` is not exported from `./fetchSources`.

- [ ] **Step 3: Implement both functions**

In `lib/finance/financials/fetchSources.ts`, add `TaxAccrualRecord` to the type import from `./aggregateRows`, add `taxAccruals: TaxAccrualRecord[];` to `FinancialsSourcesResult`, and add these two functions immediately after `fetchTipAccruals`:

```ts
/**
 * square_tax_id -> chart_of_accounts_id, for taxes that have been mapped.
 * Unmapped rows are omitted, so fetchTaxAccruals naturally emits nothing for
 * them. Degrades to an EMPTY MAP on any error -- a missing table (migration
 * 20260825 unapplied) must leave the balance sheet rendering exactly as it did
 * before, never 500 it. Same contract as fetchTipsAccountId's null.
 */
async function fetchTaxAccountMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  try {
    const { data, error } = await supabase
      .from("square_tax_accounts")
      .select("square_tax_id, chart_of_accounts_id");
    if (error) return new Map();
    const map = new Map<string, string>();
    for (const r of (data ?? []) as { square_tax_id: string; chart_of_accounts_id: string | null }[]) {
      if (r.chart_of_accounts_id) map.set(r.square_tax_id, r.chart_of_accounts_id);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * balance_sheet mode only: derived accrual of collected sales tax, grouped per
 * liability account. Unions pos_line_item_taxes and invoice_line_item_taxes.
 *
 * Grouped by square_tax_id ONLY, not by month: BS mode collapses every record
 * onto one synthetic month key (cumulativeRange's canonicalMonth), which is why
 * fetchTipAccruals emits a single record and derives monthKey from
 * range.endDateStr. Two taxes mapped to one account merge into one record.
 *
 * The COMPLETED filter is defensive rather than load-bearing: pos_line_item_taxes
 * cascades from pos_line_items, whose rows are deleted for canceled orders (see
 * syncPosTransactions.ts), so canceled tax cannot survive -- unlike
 * square_orders.tip_cents, which does and is why fetchTipAccruals needs it.
 */
export async function fetchTaxAccruals(
  supabase: SupabaseClient,
  range: DateRange,
  accountByTaxId: Map<string, string>,
): Promise<TaxAccrualRecord[]> {
  if (accountByTaxId.size === 0) return [];

  const posRows = await fetchAllRows<{ square_tax_id: string; amount_cents: number | null }>(() => {
    let q = supabase
      .from("pos_line_item_taxes")
      .select("square_tax_id, amount_cents, pos_line_items!inner ( square_orders!inner ( transaction_date, status ) )")
      .eq("pos_line_items.square_orders.status", "COMPLETED")
      .lt("pos_line_items.square_orders.transaction_date", range.end)
      .order("line_item_id", { ascending: true });
    if (range.start) q = q.gte("pos_line_items.square_orders.transaction_date", range.start);
    return q;
  });

  // Wrapped: migration 20260826 may be unapplied. Degrade to POS-only.
  let invoiceRows: { square_tax_id: string; amount_cents: number | null }[] = [];
  try {
    invoiceRows = await fetchAllRows<{ square_tax_id: string; amount_cents: number | null }>(() => {
      let q = supabase
        .from("invoice_line_item_taxes")
        .select("square_tax_id, amount_cents, invoice_line_items!inner ( invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status ) )")
        .neq("invoice_line_items.invoices.status", "voided")
        .lte("invoice_line_items.invoices.invoice_date", range.endDateStr)
        .order("line_item_id", { ascending: true });
      if (range.startDateStr) q = q.gte("invoice_line_items.invoices.invoice_date", range.startDateStr);
      return q;
    });
  } catch {
    invoiceRows = [];
  }

  const centsByAccount = new Map<string, number>();
  for (const r of [...posRows, ...invoiceRows]) {
    const coaId = accountByTaxId.get(r.square_tax_id);
    if (!coaId) continue;
    centsByAccount.set(coaId, (centsByAccount.get(coaId) ?? 0) + (r.amount_cents ?? 0));
  }

  // range.endDateStr's month IS the canonical month by construction.
  const monthKey = range.endDateStr.slice(0, 7);
  const out: TaxAccrualRecord[] = [];
  for (const [coaId, amountCents] of centsByAccount) {
    // Degenerate guard, mirroring fetchTipAccruals: the -magnitude branch signs
    // a negative sum identically to a positive one, so a negative total would
    // silently read as MORE liability.
    if (amountCents <= 0) continue;
    out.push({ id: `tax-${coaId}-${monthKey}`, chartOfAccountsId: coaId, amountCents, monthKey });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/finance/financials/fetchSources.test.ts -t "fetchTaxAccruals"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire into the entry point**

In `lib/finance/financials/fetchSources.ts`'s `fetchFinancialsSources`, add `taxAccruals` to the destructured array and the `Promise.all` list (after the `tipAccruals` entry), and to BOTH returned objects:

```ts
      isBalanceSheet
        ? fetchTipsAccountId(supabase).then((tipsAccountId) => fetchTipAccruals(supabase, range, tipsAccountId))
        : Promise.resolve<TipAccrualRecord[]>([]),
      // balance_sheet only -- chained so the settings map read stays parallel.
      isBalanceSheet
        ? fetchTaxAccountMap(supabase).then((map) => fetchTaxAccruals(supabase, range, map))
        : Promise.resolve<TaxAccrualRecord[]>([]),
    ]);
```

Destructure it as the last element:

```ts
  const [coa, pos, invoiceLines, expenses, bank, refunds, exciseCoverage, openInvoiceArCents, manualNetSalesEntries, tipAccruals, taxAccruals] =
    await Promise.all([
```

Add `taxAccruals,` beside `tipAccruals,` in both the `canonicalMonth` return and the final return. Like `tipAccruals`, it already carries the canonical `monthKey`, so it needs no `collapseDates`.

- [ ] **Step 6: Typecheck and run the module's suite**

Run: `npx tsc --noEmit && npx vitest run lib/finance/financials/`
Expected: no type errors; PASS except any `buildFinancials.test.ts` mock missing `taxAccruals` — add `taxAccruals: []` to the mocked source object.

- [ ] **Step 7: Commit**

```bash
git add lib/finance/financials/fetchSources.ts lib/finance/financials/fetchSources.test.ts lib/finance/financials/buildFinancials.test.ts
git commit -m "feat(finance): derive collected sales tax as a per-account balance-sheet accrual"
```

---

### Task 8: Wire the accrual through buildFinancials and surface unmapped taxes

**Files:**
- Modify: `lib/finance/financials/buildFinancials.ts:21-26` (HREFS), `:85-94` (aggregate call), `:123-126` (dataQuality)
- Modify: `lib/finance/financials/types.ts:35-40` (`DataQualitySummary`)
- Modify: `lib/finance/financials/summaries.ts:137-175` (`buildDataQuality`)
- Modify: `lib/finance/financials/summaries.test.ts`

**Interfaces:**
- Consumes: `fetchTaxAccruals` output via `src.taxAccruals` (Task 7); `AggregateInput.taxAccruals` (Task 6).
- Produces: `DataQualitySummary` gains `unmappedTaxes: { count: number; cents: number; href: string }`. `buildDataQuality(rows, opts)` — `opts` gains `unmappedTaxes: { count: number; cents: number }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/finance/financials/summaries.test.ts`, inside the `buildDataQuality` describe (match the existing call style for `rows`/`hrefs`):

```ts
  it("passes unmappedTaxes through from opts with its href", () => {
    const dq = buildDataQuality([], {
      hrefs: {
        unmapped: "/u", uncategorized: "/c", unknownVolume: "/v",
        exciseCoverage: "/e", unmappedTaxes: "/finance/settings/sales-tax-accounts",
      },
      exciseCoverage: { shipmentsMissingExcise: 0 },
      unmappedTaxes: { count: 1, cents: 24204 },
    });
    expect(dq.unmappedTaxes).toEqual({ count: 1, cents: 24204, href: "/finance/settings/sales-tax-accounts" });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/financials/summaries.test.ts -t "unmappedTaxes"`
Expected: FAIL — TypeScript rejects the extra `unmappedTaxes` keys on `opts` and `hrefs`.

- [ ] **Step 3: Extend the summary type**

In `lib/finance/financials/types.ts`:

```ts
export interface DataQualitySummary {
  unmapped: { count: number; cents: number; href: string };
  uncategorized: { count: number; cents: number; href: string };
  unknownVolume: { count: number; cents: number; href: string };
  exciseCoverage: { shipmentsMissingExcise: number; href: string };
  /** Square taxes collected but not mapped to a liability account -- their collections are silently omitted from the balance sheet. */
  unmappedTaxes: { count: number; cents: number; href: string };
}
```

- [ ] **Step 4: Extend buildDataQuality**

In `lib/finance/financials/summaries.ts`, add `unmappedTaxes: string;` to the `opts.hrefs` type, add `unmappedTaxes: { count: number; cents: number };` to `opts`, and add to the returned object:

```ts
    exciseCoverage: { ...opts.exciseCoverage, href: opts.hrefs.exciseCoverage },
    // Config coverage, not a property of the aggregated rows -- passed in the
    // same way exciseCoverage is.
    unmappedTaxes: { ...opts.unmappedTaxes, href: opts.hrefs.unmappedTaxes },
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run lib/finance/financials/summaries.test.ts`
Expected: PASS. Existing `buildDataQuality` tests will fail to compile until they pass the new `opts` keys — add `unmappedTaxes: "/finance/settings/sales-tax-accounts"` to their `hrefs` and `unmappedTaxes: { count: 0, cents: 0 }` to their `opts`.

- [ ] **Step 6: Wire buildFinancials**

In `lib/finance/financials/buildFinancials.ts`, add to `HREFS`:

```ts
  exciseCoverage: "/finance/transactions/invoices?filter=excise-coverage",
  unmappedTaxes: "/finance/settings/sales-tax-accounts",
```

Pass the accrual into aggregation:

```ts
    tipAccruals: src.tipAccruals,
    taxAccruals: src.taxAccruals,
    coa: src.coa,
```

And pass the coverage figure into data quality. `fetchTaxAccruals` omits unmapped taxes entirely, so the count must come from the source layer rather than being recomputed here. **`src.unmappedTaxes` does not exist yet — Step 7 adds it**, so this file will not typecheck until Step 7 is done. That is expected; the typecheck gate is Step 8. Use:

```ts
  const dataQuality = buildDataQuality(rows, {
    hrefs: HREFS,
    exciseCoverage: src.exciseCoverage,
    unmappedTaxes: src.unmappedTaxes,
  });
```

- [ ] **Step 7: Add `unmappedTaxes` to the source layer**

Back in `lib/finance/financials/fetchSources.ts`, add `unmappedTaxes: { count: number; cents: number };` to `FinancialsSourcesResult`, and compute it alongside the map. Replace the chained `Promise.all` entry from Task 7 Step 5 with a small wrapper that returns both:

```ts
      isBalanceSheet
        ? fetchTaxAccountMap(supabase).then(async (map) => ({
            accruals: await fetchTaxAccruals(supabase, range, map),
            unmapped: await fetchUnmappedTaxCoverage(supabase, map),
          }))
        : Promise.resolve({ accruals: [] as TaxAccrualRecord[], unmapped: { count: 0, cents: 0 } }),
```

Destructure as `taxBundle`, then use `taxBundle.accruals` and `taxBundle.unmapped` in the returns. Add:

```ts
/**
 * Coverage stat for the data-quality panel: how many distinct Square taxes have
 * collections but no mapped liability account, and how many cents that hides.
 * Returns zeros on any error, for the same reason fetchTaxAccountMap does.
 */
async function fetchUnmappedTaxCoverage(
  supabase: SupabaseClient,
  accountByTaxId: Map<string, string>,
): Promise<{ count: number; cents: number }> {
  try {
    const rows = await fetchAllRows<{ square_tax_id: string; amount_cents: number | null }>(() =>
      supabase.from("pos_line_item_taxes").select("square_tax_id, amount_cents").order("line_item_id", { ascending: true }),
    );
    const byTax = new Map<string, number>();
    for (const r of rows) {
      if (accountByTaxId.has(r.square_tax_id)) continue;
      byTax.set(r.square_tax_id, (byTax.get(r.square_tax_id) ?? 0) + (r.amount_cents ?? 0));
    }
    let cents = 0;
    for (const v of byTax.values()) cents += v;
    return { count: byTax.size, cents };
  } catch {
    return { count: 0, cents: 0 };
  }
}
```

- [ ] **Step 8: Typecheck and run**

Run: `npx tsc --noEmit && npx vitest run lib/finance/financials/`
Expected: no type errors; all tests PASS. Add `unmappedTaxes: { count: 0, cents: 0 }` to any `fetchFinancialsSources` mock the compiler flags.

- [ ] **Step 9: Commit**

```bash
git add lib/finance/financials/
git commit -m "feat(finance): surface the tax accrual and unmapped-tax coverage on financials"
```

---

### Task 9: Tax-account map module

**Files:**
- Create: `lib/finance/salesTaxAccounts.ts`
- Test: `lib/finance/salesTaxAccounts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface SalesTaxAccountRow { square_tax_id: string; tax_name: string | null; tax_pct: number | null; chart_of_accounts_id: string | null; chart_of_accounts: { account_name: string; account_number: string | null } | null }`
  - `listSalesTaxAccounts(sb): Promise<SalesTaxAccountRow[]>` — seeds observed taxes, then returns all rows ordered by `tax_name`.
  - `setSalesTaxAccount(sb, squareTaxId, chartOfAccountsId): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `lib/finance/salesTaxAccounts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSalesTaxAccounts, setSalesTaxAccount } from "./salesTaxAccounts";

/** Stub routing the three tables listSalesTaxAccounts touches. */
function stubSb(opts: {
  existing: { square_tax_id: string }[];
  observedPos: { square_tax_id: string; tax_name: string | null; tax_pct: number | null }[];
  observedInvoice?: { square_tax_id: string; tax_name: string | null; tax_pct: number | null }[];
  onInsert?: (rows: unknown[]) => void;
  onUpdate?: (patch: unknown, id: string) => void;
}) {
  const rows = [...opts.existing];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.eq = (_c: string, v: string) => { (b as { _id?: string })._id = v; return b; };
    b.range = (f: number, t: number) => {
      const data =
        table === "square_tax_accounts" ? rows
        : table === "pos_line_item_taxes" ? opts.observedPos
        : opts.observedInvoice ?? [];
      return Promise.resolve({ data: data.slice(f, t + 1), error: null });
    };
    b.insert = (r: unknown[]) => { opts.onInsert?.(r); return Promise.resolve({ error: null }); };
    b.update = (patch: unknown) => {
      const u: Record<string, unknown> = {};
      u.eq = (_c: string, v: string) => { opts.onUpdate?.(patch, v); return Promise.resolve({ error: null }); };
      return u;
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

describe("listSalesTaxAccounts", () => {
  it("seeds a newly observed tax with a null account", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [{ square_tax_id: "TAX_GEN" }],
      observedPos: [
        { square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25 },
        { square_tax_id: "TAX_NEW", tax_name: "New City Tax", tax_pct: 0.5 },
      ],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([[
      { square_tax_id: "TAX_NEW", tax_name: "New City Tax", tax_pct: 0.5, chart_of_accounts_id: null },
    ]]);
  });

  it("inserts nothing when every observed tax already has a row", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [{ square_tax_id: "TAX_GEN" }],
      observedPos: [{ square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25 }],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([]);
  });

  it("seeds taxes observed only on invoices", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [],
      observedPos: [],
      observedInvoice: [{ square_tax_id: "TAX_INV", tax_name: "General Sales Tax", tax_pct: 7.25 }],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([[
      { square_tax_id: "TAX_INV", tax_name: "General Sales Tax", tax_pct: 7.25, chart_of_accounts_id: null },
    ]]);
  });
});

describe("setSalesTaxAccount", () => {
  it("updates the row's account and stamps updated_at", async () => {
    const seen: { patch: Record<string, unknown>; id: string }[] = [];
    const sb = stubSb({
      existing: [], observedPos: [],
      onUpdate: (patch, id) => seen.push({ patch: patch as Record<string, unknown>, id }),
    });
    await setSalesTaxAccount(sb, "TAX_GEN", "COA_1");
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("TAX_GEN");
    expect(seen[0].patch.chart_of_accounts_id).toBe("COA_1");
    expect(typeof seen[0].patch.updated_at).toBe("string");
  });

  it("accepts null to clear a mapping", async () => {
    const seen: { patch: Record<string, unknown>; id: string }[] = [];
    const sb = stubSb({
      existing: [], observedPos: [],
      onUpdate: (patch, id) => seen.push({ patch: patch as Record<string, unknown>, id }),
    });
    await setSalesTaxAccount(sb, "TAX_GEN", null);
    expect(seen[0].patch.chart_of_accounts_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/salesTaxAccounts.test.ts`
Expected: FAIL — `Cannot find module './salesTaxAccounts'`.

- [ ] **Step 3: Implement the module**

Create `lib/finance/salesTaxAccounts.ts`:

```ts
/**
 * square_tax_accounts — maps each Square catalog tax to the balance-sheet
 * liability account its collections are credited to.
 *
 * Collected sales tax is money held for NC DOR / Wake County, not revenue.
 * Which authority a given Square tax belongs to is a business decision, so the
 * map is user-editable (Finance > Settings > Sales Tax Accounts) rather than
 * hardcoded.
 *
 * Rows SEED THEMSELVES from observed pos_line_item_taxes / invoice_line_item_taxes,
 * following the counterparty-rules precedent: a tax that starts appearing in
 * Square shows up in settings with a null account instead of being silently
 * dropped from the balance sheet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";

export interface SalesTaxAccountRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: { account_name: string; account_number: string | null } | null;
}

interface ObservedTax {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
}

/** Distinct taxes seen in a tax table. Invoice source degrades to [] if its table is missing. */
async function observedTaxes(sb: SupabaseClient, table: string, tolerateMissing: boolean): Promise<ObservedTax[]> {
  try {
    const rows = await fetchAllRows<ObservedTax>(() =>
      sb.from(table).select("square_tax_id, tax_name, tax_pct").order("line_item_id", { ascending: true }),
    );
    const byId = new Map<string, ObservedTax>();
    for (const r of rows) if (!byId.has(r.square_tax_id)) byId.set(r.square_tax_id, r);
    return [...byId.values()];
  } catch (err) {
    if (tolerateMissing) return [];
    throw err;
  }
}

/**
 * Every mapping row, seeding any observed-but-unseeded tax first. Ordered by
 * tax_name so the settings table is stable.
 */
export async function listSalesTaxAccounts(sb: SupabaseClient): Promise<SalesTaxAccountRow[]> {
  const existing = await fetchAllRows<{ square_tax_id: string }>(() =>
    sb.from("square_tax_accounts").select("square_tax_id").order("square_tax_id", { ascending: true }),
  );
  const known = new Set(existing.map((r) => r.square_tax_id));

  const [pos, invoice] = await Promise.all([
    observedTaxes(sb, "pos_line_item_taxes", false),
    observedTaxes(sb, "invoice_line_item_taxes", true),
  ]);

  const toSeed = new Map<string, ObservedTax>();
  for (const t of [...pos, ...invoice]) {
    if (!known.has(t.square_tax_id) && !toSeed.has(t.square_tax_id)) toSeed.set(t.square_tax_id, t);
  }

  if (toSeed.size > 0) {
    const { error } = await sb.from("square_tax_accounts").insert(
      [...toSeed.values()].map((t) => ({
        square_tax_id: t.square_tax_id,
        tax_name: t.tax_name,
        tax_pct: t.tax_pct,
        chart_of_accounts_id: null,
      })),
    );
    if (error) throw new Error(error.message);
  }

  // Paged on the PRIMARY KEY, not tax_name: tax_name is nullable and
  // non-unique, and an unstable sort key makes fetchAllRows' range paging drop
  // or duplicate rows. Display order is applied in JS afterwards.
  const rows = await fetchAllRows<SalesTaxAccountRow>(() =>
    sb
      .from("square_tax_accounts")
      .select("square_tax_id, tax_name, tax_pct, chart_of_accounts_id, chart_of_accounts ( account_name, account_number )")
      .order("square_tax_id", { ascending: true }),
  );
  return rows.sort((a, b) => (a.tax_name ?? a.square_tax_id).localeCompare(b.tax_name ?? b.square_tax_id));
}

/** Points one tax at a liability account, or clears it with null. */
export async function setSalesTaxAccount(
  sb: SupabaseClient,
  squareTaxId: string,
  chartOfAccountsId: string | null,
): Promise<void> {
  const { error } = await sb
    .from("square_tax_accounts")
    .update({ chart_of_accounts_id: chartOfAccountsId, updated_at: new Date().toISOString() })
    .eq("square_tax_id", squareTaxId);
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/finance/salesTaxAccounts.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/salesTaxAccounts.ts lib/finance/salesTaxAccounts.test.ts
git commit -m "feat(finance): add the self-seeding Square tax to liability account map"
```

---

### Task 10: Sales Tax Accounts settings page

**Files:**
- Create: `app/api/finance/settings/sales-tax-accounts/route.ts`
- Create: `app/finance/settings/sales-tax-accounts/page.tsx`
- Modify: `app/finance/settings/SettingsNav.tsx:4-13`

**Interfaces:**
- Consumes: `listSalesTaxAccounts`, `setSalesTaxAccount` (Task 9); `AccountSelect` + `CoARef` from `app/finance/AccountSelect`.
- Produces: `GET /api/finance/settings/sales-tax-accounts` → `SalesTaxAccountRow[]`; `PATCH` with `{ square_tax_id, chart_of_accounts_id }` → `{ ok: true }`.

- [ ] **Step 1: Create the route**

Create `app/api/finance/settings/sales-tax-accounts/route.ts`:

```ts
/**
 * Square tax -> liability account mapping. Thin wrapper over
 * lib/finance/salesTaxAccounts.ts; GET seeds any newly observed tax as a
 * side effect, matching the counterparty-rules pattern.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listSalesTaxAccounts, setSalesTaxAccount } from "@/lib/finance/salesTaxAccounts";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  try {
    return NextResponse.json(await listSalesTaxAccounts(createSupabaseAdminClient()));
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = await req.json() as { square_tax_id?: string; chart_of_accounts_id?: string | null };
    if (!body.square_tax_id) {
      return NextResponse.json({ error: "square_tax_id required" }, { status: 400 });
    }
    await setSalesTaxAccount(createSupabaseAdminClient(), body.square_tax_id, body.chart_of_accounts_id ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
```

- [ ] **Step 2: Create the page**

Create `app/finance/settings/sales-tax-accounts/page.tsx`:

```tsx
"use client";
import { useState, useEffect, useCallback } from "react";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import SaveHint from "@/app/components/ui/SaveHint";

interface CoaJoin { account_name: string; account_number: string | null }

interface TaxRow {
  square_tax_id: string;
  tax_name: string | null;
  tax_pct: number | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: CoaJoin | null;
}

// Square taxes → the balance-sheet liability account their collections are
// credited to. Sales tax is money held for NC DOR / Wake County, not revenue.
// Rows seed themselves the first time a tax is seen in a synced order.
export default function SalesTaxAccountsPage() {
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [taxes, setTaxes]       = useState<TaxRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [coaRes, taxRes] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch("/api/finance/settings/sales-tax-accounts"),
      ]);
      const [coa, tx] = await Promise.all([coaRes.json(), taxRes.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setTaxes(Array.isArray(tx) ? tx : []);
    } catch {
      setError("Failed to load sales tax accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSet(row: TaxRow, coaId: string | null) {
    setSavingId(row.square_tax_id);
    const res = await fetch("/api/finance/settings/sales-tax-accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ square_tax_id: row.square_tax_id, chart_of_accounts_id: coaId }),
    });
    setSavingId(null);
    if (!res.ok) { setError("Could not save that mapping."); return; }
    const coa = accounts.find((a) => a.id === coaId);
    const join = coa ? { account_name: coa.account_name, account_number: coa.account_number } : null;
    setTaxes((ts) => ts.map((t) => t.square_tax_id === row.square_tax_id
      ? { ...t, chart_of_accounts_id: coaId, chart_of_accounts: join }
      : t));
  }

  const mappedCount = taxes.filter((t) => t.chart_of_accounts_id).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <p className="text-sm text-muted">
          {taxes.length > 0
            ? `${mappedCount} of ${taxes.length} Square taxes mapped to a liability account`
            : "Taxes appear here after syncing orders that collected sales tax."}
        </p>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : accounts.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">Upload a chart of accounts first.</p>
            <p className="text-xs text-faint mt-1">Go to Chart of Accounts → Upload CSV.</p>
          </div>
        </div>
      ) : taxes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm text-secondary">No Square taxes yet.</p>
            <p className="text-xs text-faint mt-1">Sync orders on the Transactions → Orders tab to import them.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left text-muted font-medium">Tax</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Rate</th>
                  <th className="px-4 py-2 text-left text-muted font-medium">Liability Account</th>
                </tr>
              </thead>
              <tbody>
                {taxes.map((row) => (
                  <tr key={row.square_tax_id} className="border-t border-line/40 hover:bg-surface-mid/20">
                    <td className="px-4 py-2">
                      <span className="text-body truncate">{row.tax_name ?? row.square_tax_id}</span>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {row.tax_pct != null ? `${row.tax_pct}%` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <AccountSelect
                          value={row.chart_of_accounts_id}
                          onChange={(id) => handleSet(row, id)}
                          accounts={accounts}
                          placeholder="— map this tax —"
                          shortLabel
                          className="w-full max-w-[360px]"
                        />
                        <SaveHint saving={savingId === row.square_tax_id} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="py-3 text-2xs text-faint">
            Collected sales tax is credited to the account mapped here instead of being recognized as revenue.
            An unmapped tax contributes nothing to the balance sheet — its collections are simply omitted.
          </p>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Add the subtab**

In `app/finance/settings/SettingsNav.tsx`, add after the `counterparty-accounts` entry:

```tsx
  { href: "/finance/settings/counterparty-accounts", label: "Counterparty Accounts" },
  { href: "/finance/settings/sales-tax-accounts",    label: "Sales Tax Accounts" },
```

- [ ] **Step 4: Verify no raw colors or hand-rolled primitives**

Run: `rg -n "zinc-|amber-|red-|green-|blue-|gray-|#[0-9a-fA-F]{6}" app/finance/settings/sales-tax-accounts/page.tsx`
Expected: no matches.

- [ ] **Step 5: Lint and typecheck**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/finance/settings/sales-tax-accounts app/finance/settings/sales-tax-accounts app/finance/settings/SettingsNav.tsx
git commit -m "feat(finance): add the Sales Tax Accounts settings tab"
```

---

### Task 11: Backfill module

**Files:**
- Create: `lib/finance/backfillSalesTax.ts`
- Test: `lib/finance/backfillSalesTax.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime, but depends on Task 1's tables and Task 4's uid semantics.
- Produces: `backfillSalesTax(sb, opts: { dryRun: boolean }): Promise<BackfillSalesTaxReport>` where

```ts
export interface BackfillSalesTaxReport {
  dryRun: boolean;
  posNetSales: { scanned: number; corrected: number; skippedIdentityMismatch: number; centsRemoved: number; byMonth: Record<string, number> };
  invoiceUids: { invoicesScanned: number; rowsRepaired: number; invoicesSkipped: string[] };
  invoiceTaxes: { invoicesScanned: number; rowsWritten: number; centsWritten: number };
  invoiceTotals: { scanned: number; corrected: number };
  errors: string[];
}
```

- [ ] **Step 1: Write the failing tests**

Create `lib/finance/backfillSalesTax.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planPosNetSalesFix, planInvoiceUidRepair } from "./backfillSalesTax";

describe("planPosNetSalesFix", () => {
  it("corrects a tax-inclusive row to gross - discount", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 1200, discount_cents: 0, tax_cents: 99, net_sales_cents: 1299, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([{ id: "a", net_sales_cents: 1200 }]);
    expect(plan.centsRemoved).toBe(99);
    expect(plan.byMonth).toEqual({ "2026-06": 99 });
    expect(plan.skippedIdentityMismatch).toBe(0);
  });

  it("is idempotent — an already-corrected row is skipped", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 1200, discount_cents: 0, tax_cents: 99, net_sales_cents: 1200, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.centsRemoved).toBe(0);
    expect(plan.skippedIdentityMismatch).toBe(0);
  });

  it("refuses a row that violates net = gross - discount + tax", () => {
    const plan = planPosNetSalesFix([
      { id: "bad", gross_sales_cents: 1000, discount_cents: 0, tax_cents: 50, net_sales_cents: 9999, month: "2026-06" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.skippedIdentityMismatch).toBe(1);
  });

  it("accumulates removed tax per month", () => {
    const plan = planPosNetSalesFix([
      { id: "a", gross_sales_cents: 100, discount_cents: 0, tax_cents: 7, net_sales_cents: 107, month: "2026-05" },
      { id: "b", gross_sales_cents: 200, discount_cents: 0, tax_cents: 14, net_sales_cents: 214, month: "2026-06" },
      { id: "c", gross_sales_cents: 300, discount_cents: 0, tax_cents: 21, net_sales_cents: 321, month: "2026-06" },
    ]);
    expect(plan.byMonth).toEqual({ "2026-05": 7, "2026-06": 35 });
    expect(plan.centsRemoved).toBe(42);
  });
});

describe("planInvoiceUidRepair", () => {
  const rawLines = [
    { uid: "u-a", name: "Packaging Fee", gross_sales_money: { amount: 100 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
    { uid: "u-excise", name: "Barrel Excise Tax", gross_sales_money: { amount: 500 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 0 } },
    { uid: "u-c", name: "CO2 Refill", gross_sales_money: { amount: 900 }, total_discount_money: { amount: 0 }, total_tax_money: { amount: 65 } },
  ];
  const carveOuts = [500];

  it("maps sort_order to the right uid across a skipped excise line", () => {
    const res = planInvoiceUidRepair(
      rawLines, carveOuts,
      [
        { id: "r0", sort_order: 0, gross_sales_cents: 100, discount_cents: 0, tax_cents: 0, square_line_item_uid: "u-a" },
        { id: "r1", sort_order: 1, gross_sales_cents: 900, discount_cents: 0, tax_cents: 65, square_line_item_uid: "u-excise" },
      ],
    );
    expect(res.ok).toBe(true);
    expect(res.updates).toEqual([{ id: "r1", square_line_item_uid: "u-c" }]);
    expect(res.uidByRowId).toEqual({ r0: "u-a", r1: "u-c" });
  });

  it("refuses the invoice when a row's money triple does not match its mapped line", () => {
    const res = planInvoiceUidRepair(
      rawLines, carveOuts,
      [{ id: "r0", sort_order: 0, gross_sales_cents: 777, discount_cents: 0, tax_cents: 0, square_line_item_uid: null }],
    );
    expect(res.ok).toBe(false);
    expect(res.updates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/finance/backfillSalesTax.test.ts`
Expected: FAIL — `Cannot find module './backfillSalesTax'`.

- [ ] **Step 3: Implement the pure planners plus the driver**

Create `lib/finance/backfillSalesTax.ts`:

```ts
/**
 * One-time repair for the sales-tax-as-revenue bug, plus the two invoice-side
 * defects found alongside it. Dry-run by default at the route.
 *
 * Steps 2 and 3 are ordered (3 needs the key 2 repairs); 1 and 4 are
 * independent. The pure planners are exported for tests -- the driver is thin
 * I/O around them.
 *
 * NEVER run against prod from an agent. The orchestrator runs it after a backup.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";

const UPDATE_CHUNK = 50;

export interface BackfillSalesTaxReport {
  dryRun: boolean;
  posNetSales: { scanned: number; corrected: number; skippedIdentityMismatch: number; centsRemoved: number; byMonth: Record<string, number> };
  invoiceUids: { invoicesScanned: number; rowsRepaired: number; invoicesSkipped: string[] };
  invoiceTaxes: { invoicesScanned: number; rowsWritten: number; centsWritten: number };
  invoiceTotals: { scanned: number; corrected: number };
  errors: string[];
}

// ── Step 1: pos_line_items.net_sales_cents ─────────────────────────────────

export interface PosRowForFix {
  id: string;
  gross_sales_cents: number;
  discount_cents: number;
  tax_cents: number;
  net_sales_cents: number;
  month: string;
}

/**
 * Pure. net_sales_cents must become gross - discount. A row already equal to
 * that is skipped (idempotent re-runs). A row that satisfies NEITHER
 * `net == gross - discount` nor `net == gross - discount + tax` is refused
 * rather than guessed at -- the correction is only provably safe where the
 * identity holds.
 */
export function planPosNetSalesFix(rows: PosRowForFix[]) {
  const updates: { id: string; net_sales_cents: number }[] = [];
  const byMonth: Record<string, number> = {};
  let centsRemoved = 0;
  let skippedIdentityMismatch = 0;

  for (const r of rows) {
    const target = r.gross_sales_cents - r.discount_cents;
    if (r.net_sales_cents === target) continue;
    if (r.net_sales_cents !== target + r.tax_cents) { skippedIdentityMismatch++; continue; }
    updates.push({ id: r.id, net_sales_cents: target });
    centsRemoved += r.tax_cents;
    byMonth[r.month] = (byMonth[r.month] ?? 0) + r.tax_cents;
  }

  return { updates, byMonth, centsRemoved, skippedIdentityMismatch };
}

// ── Step 2: invoice_line_items.square_line_item_uid ────────────────────────

export interface RawLine {
  uid?: string;
  name?: string;
  gross_sales_money?: { amount?: number };
  total_discount_money?: { amount?: number };
  total_tax_money?: { amount?: number };
}

export interface InvoiceRowForRepair {
  id: string;
  sort_order: number;
  gross_sales_cents: number;
  discount_cents: number;
  tax_cents: number;
  square_line_item_uid: string | null;
}

/**
 * Pure. Replays buildInvoiceLineItemRows' iteration -- carve-out excise lines
 * are skipped WITHOUT advancing sort_order -- to map each persisted row's
 * sort_order back to its Square line uid.
 *
 * Every mapping is verified against the row's (gross, discount, tax) triple.
 * A single mismatch fails the whole invoice (`ok: false`), because a wrong uid
 * would attach tax to the wrong line and corrupt the NC DOR taxable base.
 */
export function planInvoiceUidRepair(
  rawLines: RawLine[],
  carveOutAmounts: number[],
  rows: InvoiceRowForRepair[],
): { ok: boolean; updates: { id: string; square_line_item_uid: string }[]; uidByRowId: Record<string, string> } {
  const remaining = [...carveOutAmounts];
  const orderedLines: RawLine[] = [];
  for (const li of rawLines) {
    const gross = li.gross_sales_money?.amount ?? 0;
    if ((li.name ?? "").toLowerCase().includes("barrel excise tax")) {
      const idx = remaining.findIndex((a) => Math.abs(a - gross) <= 1);
      if (idx >= 0) { remaining.splice(idx, 1); continue; }
    }
    orderedLines.push(li);
  }

  const updates: { id: string; square_line_item_uid: string }[] = [];
  const uidByRowId: Record<string, string> = {};

  for (const row of rows) {
    const li = orderedLines[row.sort_order];
    if (!li?.uid) return { ok: false, updates: [], uidByRowId: {} };
    const matches =
      (li.gross_sales_money?.amount ?? 0) === row.gross_sales_cents &&
      (li.total_discount_money?.amount ?? 0) === row.discount_cents &&
      (li.total_tax_money?.amount ?? 0) === row.tax_cents;
    if (!matches) return { ok: false, updates: [], uidByRowId: {} };
    uidByRowId[row.id] = li.uid;
    if (row.square_line_item_uid !== li.uid) updates.push({ id: row.id, square_line_item_uid: li.uid });
  }

  return { ok: true, updates, uidByRowId };
}

// ── Driver ─────────────────────────────────────────────────────────────────

/**
 * Per-row updates in bounded-concurrency chunks. NOT generic: rest-destructuring
 * a type parameter is a TypeScript error (TS2700 "Rest types may only be created
 * from object types"), so the parameter is a concrete object type.
 */
async function applyUpdates(
  sb: SupabaseClient,
  table: string,
  updates: Array<Record<string, unknown> & { id: string }>,
  errors: string[],
): Promise<void> {
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    const results = await Promise.all(
      chunk.map(({ id, ...patch }) => sb.from(table).update(patch).eq("id", id)),
    );
    for (const { error } of results) if (error) errors.push(`${table}: ${error.message}`);
  }
}

export async function backfillSalesTax(
  sb: SupabaseClient,
  opts: { dryRun: boolean },
): Promise<BackfillSalesTaxReport> {
  const { dryRun } = opts;
  const errors: string[] = [];

  // ── Step 1 ──
  const posRaw = await fetchAllRows<{
    id: string; gross_sales_cents: number | null; discount_cents: number | null;
    tax_cents: number | null; net_sales_cents: number | null;
    square_orders: { transaction_date: string } | { transaction_date: string }[] | null;
  }>(() =>
    sb.from("pos_line_items")
      .select("id, gross_sales_cents, discount_cents, tax_cents, net_sales_cents, square_orders!inner ( transaction_date )")
      .order("id", { ascending: true }),
  );
  const posRows: PosRowForFix[] = posRaw.map((r) => {
    const so = Array.isArray(r.square_orders) ? r.square_orders[0] : r.square_orders;
    return {
      id: r.id,
      gross_sales_cents: r.gross_sales_cents ?? 0,
      discount_cents: r.discount_cents ?? 0,
      tax_cents: r.tax_cents ?? 0,
      net_sales_cents: r.net_sales_cents ?? 0,
      month: (so?.transaction_date ?? "").slice(0, 7),
    };
  });
  const posPlan = planPosNetSalesFix(posRows);
  if (!dryRun) await applyUpdates(sb, "pos_line_items", posPlan.updates, errors);

  // ── Steps 2 + 3 ──
  const orders = await fetchAllRows<{ invoice_id: string | null; raw_data: { line_items?: RawLine[]; discounts?: { name?: string; applied_money?: { amount?: number } }[]; taxes?: { uid?: string; catalog_object_id?: string; name?: string; percentage?: string }[] } }>(() =>
    sb.from("square_orders").select("invoice_id, raw_data").not("invoice_id", "is", null).order("id", { ascending: true }),
  );

  const invoiceUids = { invoicesScanned: 0, rowsRepaired: 0, invoicesSkipped: [] as string[] };
  const invoiceTaxes = { invoicesScanned: 0, rowsWritten: 0, centsWritten: 0 };

  for (const o of orders) {
    if (!o.invoice_id) continue;
    invoiceUids.invoicesScanned++;

    const rows = await fetchAllRows<InvoiceRowForRepair>(() =>
      sb.from("invoice_line_items")
        .select("id, sort_order, gross_sales_cents, discount_cents, tax_cents, square_line_item_uid")
        .eq("invoice_id", o.invoice_id)
        .order("sort_order", { ascending: true }),
    );
    if (rows.length === 0) continue;

    const carveOuts = (o.raw_data?.discounts ?? [])
      .filter((d) => (d.name ?? "").toLowerCase().includes("carve out"))
      .map((d) => d.applied_money?.amount ?? 0)
      .filter((a) => a > 0);

    const repair = planInvoiceUidRepair(o.raw_data?.line_items ?? [], carveOuts, rows);
    if (!repair.ok) { invoiceUids.invoicesSkipped.push(o.invoice_id); continue; }

    invoiceUids.rowsRepaired += repair.updates.length;
    if (!dryRun) await applyUpdates(sb, "invoice_line_items", repair.updates, errors);

    // ── Step 3: taxes, keyed off the now-correct uid ──
    const taxByUid = new Map((o.raw_data?.taxes ?? []).map((t) => [t.uid, t]));
    const rowIdByUid = new Map(Object.entries(repair.uidByRowId).map(([rowId, uid]) => [uid, rowId]));
    const taxRows: { line_item_id: string; square_tax_id: string; tax_name: string | null; tax_pct: number | null; amount_cents: number }[] = [];
    for (const li of o.raw_data?.line_items ?? []) {
      const rowId = li.uid ? rowIdByUid.get(li.uid) : undefined;
      if (!rowId) continue;
      for (const at of (li as RawLine & { applied_taxes?: { tax_uid?: string; applied_money?: { amount?: number } }[] }).applied_taxes ?? []) {
        const tax = at.tax_uid ? taxByUid.get(at.tax_uid) : undefined;
        if (!tax) continue;
        taxRows.push({
          line_item_id: rowId,
          square_tax_id: tax.catalog_object_id ?? tax.uid ?? "",
          tax_name: tax.name ?? null,
          tax_pct: tax.percentage != null ? parseFloat(tax.percentage) : null,
          amount_cents: at.applied_money?.amount ?? 0,
        });
      }
    }
    if (taxRows.length > 0) {
      invoiceTaxes.invoicesScanned++;
      invoiceTaxes.rowsWritten += taxRows.length;
      invoiceTaxes.centsWritten += taxRows.reduce((s, t) => s + t.amount_cents, 0);
      if (!dryRun) {
        await sb.from("invoice_line_item_taxes").delete().in("line_item_id", rows.map((r) => r.id));
        const { error } = await sb.from("invoice_line_item_taxes").insert(taxRows);
        if (error) errors.push(`invoice_line_item_taxes (${o.invoice_id}): ${error.message}`);
      }
    }
  }

  // ── Step 4: invoice_line_items.total_cents ──
  const invRows = await fetchAllRows<{ id: string; gross_sales_cents: number | null; discount_cents: number | null; net_sales_cents: number | null; total_cents: number | null }>(() =>
    sb.from("invoice_line_items")
      .select("id, gross_sales_cents, discount_cents, net_sales_cents, total_cents")
      .not("net_sales_cents", "is", null)
      .order("id", { ascending: true }),
  );
  const totalUpdates = invRows
    .filter((r) => r.total_cents !== (r.gross_sales_cents ?? 0) - (r.discount_cents ?? 0))
    .map((r) => ({ id: r.id, total_cents: (r.gross_sales_cents ?? 0) - (r.discount_cents ?? 0) }));
  if (!dryRun) await applyUpdates(sb, "invoice_line_items", totalUpdates, errors);

  return {
    dryRun,
    posNetSales: {
      scanned: posRows.length,
      corrected: posPlan.updates.length,
      skippedIdentityMismatch: posPlan.skippedIdentityMismatch,
      centsRemoved: posPlan.centsRemoved,
      byMonth: posPlan.byMonth,
    },
    invoiceUids,
    invoiceTaxes,
    invoiceTotals: { scanned: invRows.length, corrected: totalUpdates.length },
    errors,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/finance/backfillSalesTax.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/finance/backfillSalesTax.ts lib/finance/backfillSalesTax.test.ts
git commit -m "feat(finance): add the dry-runnable sales-tax backfill"
```

---

### Task 12: Backfill route

**Files:**
- Create: `app/api/finance/backfill/sales-tax/route.ts`

**Interfaces:**
- Consumes: `backfillSalesTax` (Task 11).
- Produces: `POST /api/finance/backfill/sales-tax` with optional `{ dryRun?: boolean }` → `BackfillSalesTaxReport`. **`dryRun` defaults to `true`.**

- [ ] **Step 1: Create the route**

Create `app/api/finance/backfill/sales-tax/route.ts`:

```ts
/**
 * Backfill for the sales-tax-as-revenue correction -- thin wrapper over
 * lib/finance/backfillSalesTax.ts. `dryRun` defaults to `true` HERE (not only
 * in the lib) so a caller who omits the body field can never mutate anything.
 *
 * This route ships the tool; it does NOT run it against prod. See the spec's
 * deployment sequence for the human-gated rollout (backup, dryRun review,
 * then dryRun: false).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { backfillSalesTax } from "@/lib/finance/backfillSalesTax";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    let body: { dryRun?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      // No/empty body -- fall through to the dryRun: true default below.
    }
    const dryRun = body.dryRun ?? true;

    const report = await backfillSalesTax(createSupabaseAdminClient(), { dryRun });
    return NextResponse.json(report);
  } catch (err) {
    return apiError(err);
  }
}
```

- [ ] **Step 2: Verify the default is safe**

Run: `rg -n "dryRun" app/api/finance/backfill/sales-tax/route.ts`
Expected: includes `const dryRun = body.dryRun ?? true;` — the default must be `true`, never `false`.

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: PASS — lint, typecheck, and the whole test suite.

- [ ] **Step 4: Commit**

```bash
git add app/api/finance/backfill/sales-tax/route.ts
git commit -m "feat(finance): add the dry-run-by-default sales-tax backfill route"
```

---

## Verification before handoff

- [ ] `npm run verify` passes.
- [ ] `rg -n "net_sales_cents: li.total_money" lib/finance/syncPosTransactions.ts` returns **no matches** (both writers fixed).
- [ ] `rg -n "net_sales_cents.*-.*tax_cents" lib/tax/squareTaxBase.ts` returns **no matches** (base rebased).
- [ ] Every expected value in `lib/tax/squareTaxBase.test.ts` is unchanged from `git show origin/main:lib/tax/squareTaxBase.test.ts` — confirm with `git diff origin/main -- lib/tax/squareTaxBase.test.ts` showing fixture-only changes.
- [ ] No migration is applied to prod by any agent.

## Post-merge, human-gated rollout

Follow the spec's **Deployment sequence** verbatim. Summary: back up `pos_line_items` / `invoice_line_items` / `chart_of_accounts` → verify `schema_migrations` → apply `20260825` + `20260826` → deploy → create the Wake County CoA row in the UI → repoint PF&B on the new settings tab → recode the 2026-06-17 −$118.83 expense → `POST /api/finance/backfill/sales-tax` (dry run) and confirm `posNetSales.byMonth` reads exactly `{"2026-05": 69032, "2026-06": 111887, "2026-07": 107813}` with `skippedIdentityMismatch: 0` and `invoiceUids.invoicesSkipped: []` → re-`POST` with `{"dryRun": false}` → verify on Financials and re-run one NC DOR worksheet.
