# Deposit Invoice Ingredient Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the frozen per-ingredient breakdown behind every contract-brewing deposit invoice, backfill existing ones from audit history, and add a Brewing subtab to review them.

**Architecture:** One new table `deposit_invoice_ingredients` keyed to the finance-ledger `invoices` row that represents the deposit. New invoices snapshot their breakdown at generate/mark-paid time; existing invoices are backfilled by replaying `audit_log` to recover historical prices. Line totals are stored pre-scaled so the breakdown always sums to the invoiced deposit. A read-only Brewing subtab mirrors the Export Invoices view.

**Tech Stack:** Next.js 16 App Router (client components), TypeScript, Supabase Postgres (raw SQL migrations), React Query, Tailwind v4 token utilities, Vitest.

## Global Constraints

- Supabase clients: use `createSupabaseServerClient()` in route handlers, `createSupabaseAdminClient()` for privileged writes, `fetchJson` + React Query in client components. Never the browser client in a route handler.
- New API routes read/parse via existing helpers; wrap errors as `NextResponse.json({ error }, { status })`. Roles via `requireRole` from `lib/auth.ts`.
- Money: integer cents in `*_cents` columns; use `dollarsToCents` / `centsToDollars` from `lib/money.ts` at unit boundaries. Display with `fmtUsd` from `lib/utils/formatting.ts`.
- UI (`docs/UI_STANDARD.md`): token utilities only (no `zinc/amber/red/green/blue/gray`, no hex). Page shell `<main className="px-4 sm:px-6 py-4 sm:py-8">`. Reuse `SubNav`, `PageHeader`. No hand-rolled primitives.
- Schema: add a NEW migration file in `supabase/migrations/`; never hand-edit existing ones. Migration + backfill run against prod only after explicit user OK + backup (do NOT auto-apply).
- `lib/` business logic ships with co-located `*.test.ts`. Keep coverage above `vitest.config.ts` floor (lines 86, statements 86). Run `npm run test` and `npm run lint`.
- Square version `2025-04-16`; single location `LZ8TH4A632YW0`.

---

## File Structure

- `supabase/migrations/20260709_deposit_invoice_ingredients.sql` — new table + index + audit trigger.
- `lib/production/depositBreakdown.ts` — pure `buildBreakdownLines()` (proportional scaling) + `snapshotDepositBreakdown()` (DB write). NEW.
- `lib/production/depositBreakdown.test.ts` — tests for `buildBreakdownLines`. NEW.
- `lib/production/depositReconstruction.ts` — pure audit-log point-in-time replay → reconstructed breakdown. NEW.
- `lib/production/depositReconstruction.test.ts` — tests. NEW.
- `lib/square/square-invoices.ts` — add `ingredient_id` to `DepositCalculation.breakdown`. MODIFY.
- `app/api/production/allocations/[id]/invoice/route.ts` — call `snapshotDepositBreakdown` in `generate` + `mark_paid`. MODIFY.
- `app/api/production/deposit-invoices/backfill/route.ts` — admin-gated, dry-run-first backfill (POST). NEW.
- `app/api/production/deposit-invoices/route.ts` — GET list. NEW.
- `lib/query-keys.ts` — add `depositInvoices()`. MODIFY.
- `app/production/nav-config.ts` — add Brewing nav entry. MODIFY.
- `app/production/brewing/deposit-invoices/page.tsx` — page shell. NEW.
- `app/production/components/DepositInvoicesTab.tsx` — read-only review table. NEW.

---

### Task 1: Schema migration — `deposit_invoice_ingredients`

**Files:**
- Create: `supabase/migrations/20260709_deposit_invoice_ingredients.sql`

**Interfaces:**
- Produces: table `public.deposit_invoice_ingredients(id, invoice_id, ingredient_id, ingredient_name, unit, quantity_per_bbl, cost_per_unit, line_total_cents, sort_order, created_at)`.

- [ ] **Step 1: Write the migration**

```sql
-- Frozen per-ingredient breakdown behind each contract-brewing deposit invoice.
-- Attached to the finance-ledger invoices row (invoice_type='allocation_deposit').
-- line_total_cents is that ingredient's share of the deposit, pre-scaled so
-- SUM(line_total_cents) = invoices.total_cents. All rows uniform (no provenance
-- flags); replaced wholesale when a deposit is regenerated.

create table if not exists public.deposit_invoice_ingredients (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid    not null references public.invoices(id) on delete cascade,
  ingredient_id    uuid    references public.ingredients(id) on delete set null,
  ingredient_name  text    not null,
  unit             text    not null,
  quantity_per_bbl numeric not null,
  cost_per_unit    numeric not null,
  line_total_cents integer not null,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists deposit_invoice_ingredients_invoice_id_idx
  on public.deposit_invoice_ingredients(invoice_id);

drop trigger if exists audit_deposit_invoice_ingredients on public.deposit_invoice_ingredients;
create trigger audit_deposit_invoice_ingredients
  after insert or update or delete on public.deposit_invoice_ingredients
  for each row execute function public.audit_trigger_fn();
```

- [ ] **Step 2: Verify SQL parses locally (syntax sanity)**

Run: `grep -c "create table" supabase/migrations/20260709_deposit_invoice_ingredients.sql`
Expected: `1`. (The migration is applied to prod later, gated on user OK + backup — do NOT apply now.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260709_deposit_invoice_ingredients.sql
git commit -m "feat(deposit): add deposit_invoice_ingredients table"
```

---

### Task 2: `buildBreakdownLines` + `snapshotDepositBreakdown`

**Files:**
- Create: `lib/production/depositBreakdown.ts`
- Test: `lib/production/depositBreakdown.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `interface BreakdownInput { ingredient_id: string | null; name: string; unit: string; quantity_per_bbl: number; cost_per_unit: number; weight: number }` — `weight` is the ingredient's relative cost contribution (e.g. `quantity_per_bbl × cost_per_unit`, or `× volume` — any common factor cancels under scaling).
  - `interface BreakdownLine { ingredient_id: string | null; ingredient_name: string; unit: string; quantity_per_bbl: number; cost_per_unit: number; line_total_cents: number; sort_order: number }`
  - `function buildBreakdownLines(inputs: BreakdownInput[], invoiceTotalCents: number): BreakdownLine[]`
  - `async function snapshotDepositBreakdown(admin, invoiceId: string, inputs: BreakdownInput[], invoiceTotalCents: number): Promise<void>` where `admin = ReturnType<typeof createSupabaseAdminClient>`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/production/depositBreakdown.test.ts
import { describe, it, expect } from "vitest";
import { buildBreakdownLines, type BreakdownInput } from "./depositBreakdown";

const mk = (name: string, weight: number): BreakdownInput => ({
  ingredient_id: name, name, unit: "lb", quantity_per_bbl: 1, cost_per_unit: weight, weight,
});

describe("buildBreakdownLines", () => {
  it("scales line totals to sum exactly to the invoice total", () => {
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1), mk("c", 1)], 100);
    expect(lines.map((l) => l.line_total_cents)).toEqual([34, 33, 33]);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(100);
  });

  it("distributes leftover cents by largest fractional remainder", () => {
    // weights 1,1,1 over 10 cents -> 3.33 each; remainders equal -> first rows get the extra
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1), mk("c", 1)], 10);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(10);
    expect(lines[0].line_total_cents).toBe(4);
  });

  it("preserves proportions for unequal weights", () => {
    const lines = buildBreakdownLines([mk("a", 3), mk("b", 1)], 100);
    expect(lines[0].line_total_cents).toBe(75);
    expect(lines[1].line_total_cents).toBe(25);
    expect(lines.reduce((s, l) => s + l.line_total_cents, 0)).toBe(100);
  });

  it("assigns sort_order by input order and carries frozen fields", () => {
    const lines = buildBreakdownLines([mk("a", 1), mk("b", 1)], 100);
    expect(lines[0].sort_order).toBe(0);
    expect(lines[1].sort_order).toBe(1);
    expect(lines[0].ingredient_name).toBe("a");
  });

  it("returns no lines when total weight is zero", () => {
    expect(buildBreakdownLines([mk("a", 0), mk("b", 0)], 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- depositBreakdown`
Expected: FAIL — cannot find module `./depositBreakdown`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/production/depositBreakdown.ts
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

export interface BreakdownInput {
  ingredient_id: string | null;
  name: string;
  unit: string;
  quantity_per_bbl: number;
  cost_per_unit: number;
  /** Relative cost weight; common factors (volume, %) cancel under scaling. */
  weight: number;
}

export interface BreakdownLine {
  ingredient_id: string | null;
  ingredient_name: string;
  unit: string;
  quantity_per_bbl: number;
  cost_per_unit: number;
  line_total_cents: number;
  sort_order: number;
}

/**
 * Convert weighted breakdown inputs into stored lines whose integer
 * line_total_cents sum EXACTLY to invoiceTotalCents (largest-remainder rounding).
 * Returns [] when total weight is non-positive (can't proportion).
 */
export function buildBreakdownLines(
  inputs: BreakdownInput[],
  invoiceTotalCents: number
): BreakdownLine[] {
  const totalWeight = inputs.reduce((s, i) => s + Math.max(0, i.weight), 0);
  if (totalWeight <= 0 || inputs.length === 0) return [];

  const raw = inputs.map((i) => (Math.max(0, i.weight) / totalWeight) * invoiceTotalCents);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = invoiceTotalCents - floors.reduce((s, f) => s + f, 0);

  // Distribute leftover cents to the largest fractional parts (ties: lower index).
  const order = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const cents = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    cents[order[k].idx] += 1;
    remainder--;
  }

  return inputs.map((i, idx) => ({
    ingredient_id: i.ingredient_id,
    ingredient_name: i.name,
    unit: i.unit,
    quantity_per_bbl: i.quantity_per_bbl,
    cost_per_unit: i.cost_per_unit,
    line_total_cents: cents[idx],
    sort_order: idx,
  }));
}

/**
 * Replace the stored breakdown for a deposit invoice with a fresh snapshot.
 * Deletes existing lines then inserts the scaled lines. No-op insert if empty.
 */
export async function snapshotDepositBreakdown(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  invoiceId: string,
  inputs: BreakdownInput[],
  invoiceTotalCents: number
): Promise<void> {
  const lines = buildBreakdownLines(inputs, invoiceTotalCents);

  await admin.from("deposit_invoice_ingredients").delete().eq("invoice_id", invoiceId);

  if (lines.length === 0) return;

  await admin.from("deposit_invoice_ingredients").insert(
    lines.map((l) => ({
      invoice_id: invoiceId,
      ingredient_id: l.ingredient_id,
      ingredient_name: l.ingredient_name,
      unit: l.unit,
      quantity_per_bbl: l.quantity_per_bbl,
      cost_per_unit: l.cost_per_unit,
      line_total_cents: l.line_total_cents,
      sort_order: l.sort_order,
    }))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- depositBreakdown`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/depositBreakdown.ts lib/production/depositBreakdown.test.ts
git commit -m "feat(deposit): breakdown line scaling + snapshot helper"
```

---

### Task 3: Wire snapshot into generate + mark_paid

**Files:**
- Modify: `lib/square/square-invoices.ts:22-28` (add `ingredient_id` to breakdown) and `:124-130` (push `ingredient_id`)
- Modify: `app/api/production/allocations/[id]/invoice/route.ts`

**Interfaces:**
- Consumes: `snapshotDepositBreakdown`, `BreakdownInput` (Task 2); `calculateIngredientDeposit` returning `DepositCalculation` (existing).
- Produces: deposit invoices now persist their breakdown at generate/mark_paid.

- [ ] **Step 1: Add `ingredient_id` to the DepositCalculation breakdown type**

In `lib/square/square-invoices.ts`, change the `breakdown` array type (currently at lines 22-28) to include `ingredient_id`:

```typescript
  breakdown: Array<{
    ingredient_id: string;
    name: string;
    quantity_per_bbl: number;
    cost_per_unit: number;
    unit: string;
    line_total_usd: number;
  }>;
```

And in the loop that builds `breakdown` (currently `breakdown.push({...})` around line 124), add the id:

```typescript
    breakdown.push({
      ingredient_id: ing.id,
      name: ing.name,
      quantity_per_bbl: qtyPerBbl,
      cost_per_unit: costPerUnit,
      unit: ing.unit,
      line_total_usd: lineTotal,
    });
```

- [ ] **Step 2: Add a mapper + snapshot call in the `generate` action**

In `app/api/production/allocations/[id]/invoice/route.ts`, add the import at the top:

```typescript
import { snapshotDepositBreakdown, type BreakdownInput } from "@/lib/production/depositBreakdown";
```

Add a module-level helper near the other helpers (bottom of file):

```typescript
function calcToBreakdownInputs(calc: { breakdown: Array<{ ingredient_id: string; name: string; unit: string; quantity_per_bbl: number; cost_per_unit: number; line_total_usd: number }> }): BreakdownInput[] {
  return calc.breakdown.map((b) => ({
    ingredient_id: b.ingredient_id,
    name: b.name,
    unit: b.unit,
    quantity_per_bbl: b.quantity_per_bbl,
    cost_per_unit: b.cost_per_unit,
    weight: b.line_total_usd, // full-batch cost; volume/% cancel under scaling
  }));
}
```

In the `generate` action, immediately after the `if (ledgerInvoiceId) { ... invoice_batch_links ... }` block (currently ends line 216) and before the `return NextResponse.json(...)` at line 218, add:

```typescript
    if (ledgerInvoiceId) {
      await snapshotDepositBreakdown(
        adminSupabase,
        ledgerInvoiceId,
        calcToBreakdownInputs(calculation),
        calculation.deposit_cents
      );
    }
```

- [ ] **Step 3: Snapshot in the `mark_paid` action**

In the `mark_paid` action, after the `if (inv?.id) { ... invoice_batch_links ... }` block (currently ends ~line 394) and before `return NextResponse.json({ allocation: updated })`, add:

```typescript
    if (inv?.id) {
      try {
        const calc = await calculateIngredientDeposit(supabase, batch.id, Number(allocation.percentage));
        await snapshotDepositBreakdown(adminSupabase, inv.id, calcToBreakdownInputs(calc), amountCents);
      } catch (e) {
        console.error("[deposit-invoice] mark_paid breakdown snapshot failed:", e);
      }
    }
```

(The snapshot is best-effort here: external mark-paid must not fail if the recipe has no costs. Existing paid invoices get precise historical prices via the Task 5 backfill.)

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors introduced by these files.

- [ ] **Step 5: Commit**

```bash
git add lib/square/square-invoices.ts "app/api/production/allocations/[id]/invoice/route.ts"
git commit -m "feat(deposit): snapshot ingredient breakdown on generate + mark_paid"
```

---

### Task 4: `depositReconstruction` — point-in-time audit replay

**Files:**
- Create: `lib/production/depositReconstruction.ts`
- Test: `lib/production/depositReconstruction.test.ts`

**Interfaces:**
- Consumes: `BreakdownInput` from `lib/production/depositBreakdown.ts`.
- Produces:
  - `interface AuditRow { table_name: string; record_id: string; operation: string; changed_at: string; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null }`
  - `function reconstructFieldAsOf(rows: AuditRow[], field: string, asOf: string, fallback: number): number` — `rows` pre-filtered to one record_id.
  - `interface RecipeIngredientNow { recipe_ingredient_id: string; ingredient_id: string; quantity_per_bbl: number }`
  - `interface IngredientNow { id: string; name: string; unit: string; cost_per_unit: number | null }`
  - `function reconstructBreakdownAsOf(params: { asOf: string; recipeIngredientsNow: RecipeIngredientNow[]; ingredientsNow: Map<string, IngredientNow>; audit: AuditRow[] }): BreakdownInput[]`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/production/depositReconstruction.test.ts
import { describe, it, expect } from "vitest";
import {
  reconstructFieldAsOf,
  reconstructBreakdownAsOf,
  type AuditRow,
} from "./depositReconstruction";

const row = (over: Partial<AuditRow>): AuditRow => ({
  table_name: "ingredients", record_id: "i1", operation: "UPDATE",
  changed_at: "2026-01-01T00:00:00Z", old_data: null, new_data: null, ...over,
});

describe("reconstructFieldAsOf", () => {
  it("returns the latest new_data value at or before asOf", () => {
    const rows = [
      row({ changed_at: "2026-01-10T00:00:00Z", new_data: { cost_per_unit: 2 } }),
      row({ changed_at: "2026-02-10T00:00:00Z", new_data: { cost_per_unit: 5 } }),
    ];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-20T00:00:00Z", 9)).toBe(2);
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-03-01T00:00:00Z", 9)).toBe(5);
  });

  it("uses the earliest old_data when asOf precedes all changes", () => {
    const rows = [row({ changed_at: "2026-02-10T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } })];
    expect(reconstructFieldAsOf(rows, "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(2);
  });

  it("falls back to the current value when there is no audit history", () => {
    expect(reconstructFieldAsOf([], "cost_per_unit", "2026-01-01T00:00:00Z", 9)).toBe(9);
  });
});

describe("reconstructBreakdownAsOf", () => {
  const ingredientsNow = new Map([
    ["i1", { id: "i1", name: "Malt", unit: "lb", cost_per_unit: 5 }],
    ["i2", { id: "i2", name: "Hops", unit: "oz", cost_per_unit: 3 }],
  ]);

  it("uses historical prices/quantities at asOf", () => {
    const audit: AuditRow[] = [
      { table_name: "ingredients", record_id: "i1", operation: "UPDATE", changed_at: "2026-03-01T00:00:00Z", old_data: { cost_per_unit: 2 }, new_data: { cost_per_unit: 5 } },
    ];
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [{ recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 }],
      ingredientsNow, audit,
    });
    expect(out).toHaveLength(1);
    expect(out[0].cost_per_unit).toBe(2); // historical, not current 5
    expect(out[0].weight).toBe(20); // 10 * 2
  });

  it("excludes a recipe ingredient inserted after asOf", () => {
    const audit: AuditRow[] = [
      { table_name: "recipe_ingredients", record_id: "r2", operation: "INSERT", changed_at: "2026-05-01T00:00:00Z", old_data: null, new_data: { id: "r2", ingredient_id: "i2", quantity_per_bbl: 4 } },
    ];
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [
        { recipe_ingredient_id: "r1", ingredient_id: "i1", quantity_per_bbl: 10 },
        { recipe_ingredient_id: "r2", ingredient_id: "i2", quantity_per_bbl: 4 },
      ],
      ingredientsNow, audit,
    });
    expect(out.map((b) => b.ingredient_id)).toEqual(["i1"]);
  });

  it("skips ingredients with no known cost", () => {
    const out = reconstructBreakdownAsOf({
      asOf: "2026-02-01T00:00:00Z",
      recipeIngredientsNow: [{ recipe_ingredient_id: "r3", ingredient_id: "i3", quantity_per_bbl: 10 }],
      ingredientsNow, audit: [],
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- depositReconstruction`
Expected: FAIL — cannot find module `./depositReconstruction`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/production/depositReconstruction.ts
import type { BreakdownInput } from "./depositBreakdown";

export interface AuditRow {
  table_name: string;
  record_id: string;
  operation: string;
  changed_at: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

export interface RecipeIngredientNow {
  recipe_ingredient_id: string;
  ingredient_id: string;
  quantity_per_bbl: number;
}

export interface IngredientNow {
  id: string;
  name: string;
  unit: string;
  cost_per_unit: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Value of `field` for a single record as of `asOf`. `rows` must already be
 * filtered to one record_id (any table). Returns the last write at/before asOf;
 * if asOf precedes all writes, the earliest old_data value; else `fallback`.
 */
export function reconstructFieldAsOf(
  rows: AuditRow[],
  field: string,
  asOf: string,
  fallback: number
): number {
  const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  let latest: number | null = null;
  for (const r of sorted) {
    if (r.changed_at <= asOf && r.new_data && field in r.new_data) {
      const v = num(r.new_data[field]);
      if (v != null) latest = v;
    }
  }
  if (latest != null) return latest;
  const first = sorted.find((r) => r.old_data && field in r.old_data);
  const pre = first ? num(first.old_data![field]) : null;
  return pre != null ? pre : fallback;
}

/** True if this recipe_ingredient's first audit event is an INSERT after asOf. */
function insertedAfter(rows: AuditRow[], asOf: string): boolean {
  const sorted = [...rows].sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  const first = sorted[0];
  return !!first && first.operation === "INSERT" && first.changed_at > asOf;
}

/**
 * Reconstruct the frozen breakdown weights for an allocation's recipe as of
 * `asOf`. Starts from the current recipe_ingredients, drops rows inserted after
 * asOf, and uses historical cost/quantity. `weight = qty × cost` (volume and
 * allocation % are common factors that cancel under buildBreakdownLines scaling).
 */
export function reconstructBreakdownAsOf(params: {
  asOf: string;
  recipeIngredientsNow: RecipeIngredientNow[];
  ingredientsNow: Map<string, IngredientNow>;
  audit: AuditRow[];
}): BreakdownInput[] {
  const { asOf, recipeIngredientsNow, ingredientsNow, audit } = params;

  const byRecord = new Map<string, AuditRow[]>();
  for (const r of audit) {
    const key = `${r.table_name}:${r.record_id}`;
    (byRecord.get(key) ?? byRecord.set(key, []).get(key)!).push(r);
  }
  const rowsFor = (table: string, id: string) => byRecord.get(`${table}:${id}`) ?? [];

  const out: BreakdownInput[] = [];
  for (const ri of recipeIngredientsNow) {
    const riRows = rowsFor("recipe_ingredients", ri.recipe_ingredient_id);
    if (insertedAfter(riRows, asOf)) continue;

    const ing = ingredientsNow.get(ri.ingredient_id);
    const ingRows = rowsFor("ingredients", ri.ingredient_id);

    const qty = reconstructFieldAsOf(riRows, "quantity_per_bbl", asOf, ri.quantity_per_bbl);
    const cost = reconstructFieldAsOf(ingRows, "cost_per_unit", asOf, ing?.cost_per_unit ?? NaN);
    if (!Number.isFinite(cost)) continue;

    out.push({
      ingredient_id: ri.ingredient_id,
      name: ing?.name ?? "Unknown ingredient",
      unit: ing?.unit ?? "",
      quantity_per_bbl: qty,
      cost_per_unit: cost,
      weight: qty * cost,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- depositReconstruction`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/depositReconstruction.ts lib/production/depositReconstruction.test.ts
git commit -m "feat(deposit): audit-log point-in-time breakdown reconstruction"
```

---

### Task 5: Backfill route (admin-gated, dry-run first)

**Files:**
- Create: `app/api/production/deposit-invoices/backfill/route.ts`

**Interfaces:**
- Consumes: `reconstructBreakdownAsOf`, `AuditRow`, `RecipeIngredientNow`, `IngredientNow` (Task 4); `buildBreakdownLines` (Task 2); `createSupabaseAdminClient`.
- Produces: `POST /api/production/deposit-invoices/backfill` — dry-run by default; `{ "apply": true }` in the body writes rows. Returns `{ mode, summary, results[] }`.

Implemented as a route (not a standalone script) so path aliases, env, and the admin client resolve through the Next runtime — this codebase has no `tsx`/`dotenv` harness.

- [ ] **Step 1: Write the route**

```typescript
// app/api/production/deposit-invoices/backfill/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildBreakdownLines } from "@/lib/production/depositBreakdown";
import {
  reconstructBreakdownAsOf,
  type AuditRow,
  type RecipeIngredientNow,
  type IngredientNow,
} from "@/lib/production/depositReconstruction";

export const dynamic = "force-dynamic";

// POST { apply?: boolean } — reconstruct + (optionally) write frozen breakdowns
// for every existing deposit invoice. Admin only. Dry-run unless apply === true.
export async function POST(req: NextRequest) {
  try { await requireRole(["admin"]); } catch (res) { return res as Response; }

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;
  const db = createSupabaseAdminClient();

  const { data: invoices, error } = await db
    .from("invoices")
    .select("id, total_cents, invoice_date, allocation_id, batch_allocations!allocation_id(percentage, invoice_generated_at, invoice_sent_at, invoice_paid_at, batch_id, brew_batches(recipe_id))")
    .eq("invoice_type", "allocation_deposit")
    .not("allocation_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Array<{ invoice_id: string; status: string; lines: number; sum_cents: number; total_cents: number }> = [];
  let written = 0, skipped = 0;

  for (const inv of invoices ?? []) {
    const alloc = inv.batch_allocations as unknown as {
      percentage: number | null; invoice_generated_at: string | null; invoice_sent_at: string | null;
      invoice_paid_at: string | null; brew_batches: { recipe_id: string | null } | null;
    } | null;
    const recipeId = alloc?.brew_batches?.recipe_id ?? null;
    if (!recipeId || !inv.total_cents) {
      skipped++; results.push({ invoice_id: inv.id, status: "skipped:no-recipe-or-total", lines: 0, sum_cents: 0, total_cents: inv.total_cents ?? 0 });
      continue;
    }

    const asOf: string =
      alloc!.invoice_generated_at ?? alloc!.invoice_sent_at ?? alloc!.invoice_paid_at ?? `${inv.invoice_date}T00:00:00Z`;

    const { data: ris } = await db
      .from("recipe_ingredients")
      .select("id, ingredient_id, quantity_per_bbl, ingredients(id, name, unit, cost_per_unit)")
      .eq("recipe_id", recipeId);

    const recipeIngredientsNow: RecipeIngredientNow[] = (ris ?? []).map((r) => {
      const rr = r as unknown as { id: string; ingredient_id: string; quantity_per_bbl: number };
      return { recipe_ingredient_id: rr.id, ingredient_id: rr.ingredient_id, quantity_per_bbl: Number(rr.quantity_per_bbl) };
    });
    const ingredientsNow = new Map<string, IngredientNow>(
      (ris ?? []).map((r) => {
        const rr = r as unknown as { ingredient_id: string; ingredients: { id: string; name: string; unit: string; cost_per_unit: number | null } };
        return [rr.ingredient_id, {
          id: rr.ingredients.id, name: rr.ingredients.name, unit: rr.ingredients.unit,
          cost_per_unit: rr.ingredients.cost_per_unit == null ? null : Number(rr.ingredients.cost_per_unit),
        }] as const;
      })
    );

    const ingIds = recipeIngredientsNow.map((r) => r.ingredient_id);
    const riIds = recipeIngredientsNow.map((r) => r.recipe_ingredient_id);
    const auditSel = "table_name, record_id, operation, changed_at, old_data, new_data";
    const { data: auditIng } = ingIds.length
      ? await db.from("audit_log").select(auditSel).eq("table_name", "ingredients").in("record_id", ingIds)
      : { data: [] };
    const { data: auditRi } = riIds.length
      ? await db.from("audit_log").select(auditSel).eq("table_name", "recipe_ingredients").in("record_id", riIds)
      : { data: [] };
    const audit = [...(auditIng ?? []), ...(auditRi ?? [])] as AuditRow[];

    const inputs = reconstructBreakdownAsOf({ asOf, recipeIngredientsNow, ingredientsNow, audit });
    const lines = buildBreakdownLines(inputs, inv.total_cents);

    if (lines.length === 0) {
      skipped++; results.push({ invoice_id: inv.id, status: "skipped:no-lines", lines: 0, sum_cents: 0, total_cents: inv.total_cents });
      continue;
    }

    const sum = lines.reduce((s, l) => s + l.line_total_cents, 0);
    results.push({ invoice_id: inv.id, status: apply ? "written" : "dry-run", lines: lines.length, sum_cents: sum, total_cents: inv.total_cents });

    if (apply) {
      await db.from("deposit_invoice_ingredients").delete().eq("invoice_id", inv.id);
      await db.from("deposit_invoice_ingredients").insert(
        lines.map((l) => ({
          invoice_id: inv.id, ingredient_id: l.ingredient_id, ingredient_name: l.ingredient_name,
          unit: l.unit, quantity_per_bbl: l.quantity_per_bbl, cost_per_unit: l.cost_per_unit,
          line_total_cents: l.line_total_cents, sort_order: l.sort_order,
        }))
      );
      written++;
    }
  }

  return NextResponse.json({
    mode: apply ? "apply" : "dry-run",
    summary: { total: invoices?.length ?? 0, written, skipped },
    results,
  });
}
```

- [ ] **Step 2: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors. (Do NOT invoke the route against prod yet — that is gated on user approval + backup, coordinated in the post-implementation section.)

- [ ] **Step 3: Commit**

```bash
git add app/api/production/deposit-invoices/backfill/route.ts
git commit -m "feat(deposit): admin backfill route for historical breakdowns (dry-run default)"
```

---

### Task 6: Read route + query key

**Files:**
- Create: `app/api/production/deposit-invoices/route.ts`
- Modify: `lib/query-keys.ts:69` (add `depositInvoices` after `exportInvoices`)

**Interfaces:**
- Produces: `GET /api/production/deposit-invoices` → `DepositInvoiceListItem[]` (shape below); `queryKeys.production.depositInvoices()`.

```typescript
interface DepositBreakdownLine {
  id: string; ingredient_name: string; unit: string;
  quantity_per_bbl: number; cost_per_unit: number; line_total_cents: number; sort_order: number;
}
interface DepositInvoiceListItem {
  id: string; invoice_number: string | null; invoice_date: string | null;
  customer_name: string | null; partner_id: string | null; partner_name: string | null;
  status: string; source: string; square_invoice_id: string | null; square_dashboard_url: string | null;
  total_cents: number; percentage: number | null;
  beer_name: string | null; batch_number: number | null; volume_bbl: number | null;
  generated_at: string | null; sent_at: string | null; paid_at: string | null;
  breakdown: DepositBreakdownLine[];
}
```

- [ ] **Step 1: Add the query key**

In `lib/query-keys.ts`, directly after the `exportInvoices` line (currently line 69), add:

```typescript
    depositInvoices:       () => ["production", "deposit-invoices"] as const,
```

- [ ] **Step 2: Write the route**

```typescript
// app/api/production/deposit-invoices/route.ts
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
      status, source, square_invoice_id, total_cents,
      deposit_invoice_ingredients(
        id, ingredient_name, unit, quantity_per_bbl, cost_per_unit, line_total_cents, sort_order
      ),
      contract_brewing_partners!partner_id(company_name),
      batch_allocations!allocation_id(
        percentage, invoice_generated_at, invoice_sent_at, invoice_paid_at,
        brew_batches(beer_name, batch_number, volume_bbl)
      )
    `)
    .eq("invoice_type", "allocation_deposit")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as unknown as { company_name: string } | null;
    const alloc = inv.batch_allocations as unknown as {
      percentage: number | null; invoice_generated_at: string | null;
      invoice_sent_at: string | null; invoice_paid_at: string | null;
      brew_batches: { beer_name: string; batch_number: number; volume_bbl: number } | null;
    } | null;
    const squareDashboardUrl = inv.square_invoice_id
      ? `https://app.squareup.com/dashboard/invoices/${inv.square_invoice_id}/edit?currentUnitToken=${process.env.SQUARE_LOCATION_ID}`
      : null;
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
      square_dashboard_url: squareDashboardUrl,
      total_cents: inv.total_cents,
      percentage: alloc?.percentage ?? null,
      beer_name: alloc?.brew_batches?.beer_name ?? null,
      batch_number: alloc?.brew_batches?.batch_number ?? null,
      volume_bbl: alloc?.brew_batches?.volume_bbl ?? null,
      generated_at: alloc?.invoice_generated_at ?? null,
      sent_at: alloc?.invoice_sent_at ?? null,
      paid_at: alloc?.invoice_paid_at ?? null,
      breakdown: (inv.deposit_invoice_ingredients ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
    };
  });

  return NextResponse.json(enriched);
}
```

- [ ] **Step 3: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/production/deposit-invoices/route.ts lib/query-keys.ts
git commit -m "feat(deposit): GET /api/production/deposit-invoices list route"
```

---

### Task 7: Brewing subtab UI

**Files:**
- Modify: `app/production/nav-config.ts:13-18` (add nav entry)
- Create: `app/production/brewing/deposit-invoices/page.tsx`
- Create: `app/production/components/DepositInvoicesTab.tsx`

**Interfaces:**
- Consumes: `GET /api/production/deposit-invoices`, `queryKeys.production.depositInvoices()` (Task 6); `useContractPartnersQuery` from `app/production/hooks/queries` (existing, used by ExportInvoicesTab).

- [ ] **Step 1: Add the Brewing nav entry**

In `app/production/nav-config.ts`, add to `BREWING_NAV` (after the Transfers entry, line 17):

```typescript
  { href: "/production/brewing/deposit-invoices", label: "Deposit Invoices" },
```

- [ ] **Step 2: Create the page shell**

```typescript
// app/production/brewing/deposit-invoices/page.tsx
"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import DepositInvoicesTab from "@/app/production/components/DepositInvoicesTab";
import PageHeader from "@/app/components/PageHeader";

export default function DepositInvoicesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Brewing" description="Deposit invoices for contract-brewing allocations" />
      <SubNav entries={BREWING_NAV} sticky />
      <div className="mt-4"><DepositInvoicesTab /></div>
    </main>
  );
}
```

- [ ] **Step 3: Create the read-only review component**

```typescript
// app/production/components/DepositInvoicesTab.tsx
"use client";

import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { fmtUsd } from "@/lib/utils/formatting";

interface DepositBreakdownLine {
  id: string; ingredient_name: string; unit: string;
  quantity_per_bbl: number; cost_per_unit: number; line_total_cents: number; sort_order: number;
}
interface DepositInvoiceListItem {
  id: string; invoice_number: string | null; invoice_date: string | null;
  customer_name: string | null; partner_id: string | null; partner_name: string | null;
  status: string; source: string; square_invoice_id: string | null; square_dashboard_url: string | null;
  total_cents: number; percentage: number | null;
  beer_name: string | null; batch_number: number | null; volume_bbl: number | null;
  generated_at: string | null; sent_at: string | null; paid_at: string | null;
  breakdown: DepositBreakdownLine[];
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-surface-mid text-secondary",
  open: "bg-accent-muted/40 text-accent",
  paid: "bg-success-surface/40 text-success",
  voided: "bg-danger-surface/40 text-danger",
  partial: "bg-info-surface/40 text-info",
  unknown: "bg-surface-mid text-muted",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", open: "Sent / Open", paid: "Paid", voided: "Voided", partial: "Partial", unknown: "Unknown",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ExpandedPanel({ invoice }: { invoice: DepositInvoiceListItem }) {
  const panelClass = "rounded border border-line bg-surface/40 p-3 space-y-2";
  const breakdownTotal = invoice.breakdown.reduce((s, l) => s + l.line_total_cents, 0);
  return (
    <div className="px-4 pb-4 space-y-3">
      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Deposit Details</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <span className="text-muted">Partner</span>
          <span className="text-strong">{invoice.partner_name ?? invoice.customer_name ?? "—"}</span>
          <span className="text-muted">Batch</span>
          <span className="text-body">{invoice.beer_name ? `${invoice.batch_number != null ? `#${invoice.batch_number} ` : ""}${invoice.beer_name}` : "—"}</span>
          <span className="text-muted">Allocation</span>
          <span className="text-body">{invoice.percentage != null ? `${invoice.percentage.toFixed(1)}%` : "—"}{invoice.volume_bbl != null ? ` of ${invoice.volume_bbl.toFixed(1)} bbl` : ""}</span>
          <span className="text-muted">Generated</span>
          <span className="text-body">{invoice.generated_at ? fmt(invoice.generated_at) : "—"}</span>
          <span className="text-muted">Paid</span>
          <span className="text-body">{invoice.paid_at ? fmt(invoice.paid_at) : "—"}</span>
          <span className="text-muted">Status</span>
          <span><span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_BADGE[invoice.status] ?? STATUS_BADGE.unknown}`}>{STATUS_LABEL[invoice.status] ?? invoice.status}</span></span>
          {invoice.square_dashboard_url && (
            <React.Fragment>
              <span className="text-muted">Square</span>
              <a href={invoice.square_dashboard_url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:text-accent-soft underline">View in Square →</a>
            </React.Fragment>
          )}
        </div>
      </div>

      <div className={panelClass}>
        <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-1">Frozen Ingredient Breakdown</p>
        {invoice.breakdown.length === 0 ? (
          <p className="text-xs text-faint">No breakdown recorded for this deposit.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted border-b border-line">
                <th className="pb-1">Ingredient</th>
                <th className="pb-1 text-right">Qty / bbl</th>
                <th className="pb-1 text-right">Unit Cost</th>
                <th className="pb-1 text-right">Deposit Share</th>
              </tr>
            </thead>
            <tbody>
              {invoice.breakdown.map((l) => (
                <tr key={l.id} className="border-b border-line/50 last:border-0">
                  <td className="py-1 text-strong">{l.ingredient_name}</td>
                  <td className="py-1 text-right text-secondary">{l.quantity_per_bbl} {l.unit}</td>
                  <td className="py-1 text-right text-secondary">{fmtUsd(l.cost_per_unit)}</td>
                  <td className="py-1 text-right text-body">{fmtUsd(l.line_total_cents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end pt-1 border-t border-line mt-1">
          <span className="text-xs text-secondary">Total: <span className="text-primary font-medium">{fmtUsd(breakdownTotal / 100)}</span></span>
        </div>
      </div>
    </div>
  );
}

export default function DepositInvoicesTab() {
  const { data: invoices = [] } = useQuery({
    queryKey: queryKeys.production.depositInvoices(),
    queryFn: () => fetchJson<DepositInvoiceListItem[]>("/api/production/deposit-invoices"),
  });
  const { data: partners = [] } = useContractPartnersQuery();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [customerFilter, setCustomerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState<string>("all");

  const years = useMemo(() => {
    const ys = new Set(invoices.map((inv) => inv.invoice_date?.slice(0, 4)).filter(Boolean) as string[]);
    return [...ys].sort().reverse();
  }, [invoices]);

  const filtered = useMemo(() => invoices.filter((inv) => {
    if (customerFilter !== "all" && inv.partner_id !== customerFilter) return false;
    if (statusFilter !== "all" && inv.status !== statusFilter) return false;
    if (yearFilter !== "all" && inv.invoice_date?.slice(0, 4) !== yearFilter) return false;
    return true;
  }), [invoices, customerFilter, statusFilter, yearFilter]);

  const openTotal = filtered.filter((inv) => inv.status === "open" || inv.status === "draft").reduce((s, inv) => s + inv.total_cents, 0);
  const grandTotal = filtered.reduce((s, inv) => s + inv.total_cents, 0);
  const selCls = "bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="dep-customer" className="sr-only">Filter by customer</label>
        <select id="dep-customer" value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} className={selCls}>
          <option value="all">All Customers</option>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
        </select>
        <label htmlFor="dep-status" className="sr-only">Filter by status</label>
        <select id="dep-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selCls}>
          <option value="all">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Sent / Open</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
        </select>
        <label htmlFor="dep-year" className="sr-only">Filter by year</label>
        <select id="dep-year" value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} className={selCls}>
          <option value="all">All Years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-6 px-4 py-2 bg-surface/60 border border-line rounded text-xs">
        <span className="text-secondary">{filtered.length} invoice{filtered.length !== 1 ? "s" : ""}</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-accent-soft font-medium">{fmtUsd(openTotal / 100)}</span> open</span>
        <span className="text-muted">|</span>
        <span className="text-secondary"><span className="text-strong font-medium">{fmtUsd(grandTotal / 100)}</span> total</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-faint">No deposit invoices match the current filters.</p>
      ) : (
        <div className="rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 w-6" aria-label="Expand" />
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Invoice #</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Customer</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Status</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isExpanded = expandedId === inv.id;
                return (
                  <React.Fragment key={inv.id}>
                    <tr className="border-b border-line hover:bg-surface/30 cursor-pointer transition-colors" onClick={() => setExpandedId(isExpanded ? null : inv.id)}>
                      <td className="px-4 py-2.5 text-muted text-xs">{isExpanded ? "▾" : "▸"}</td>
                      <td className="px-4 py-2.5 text-strong font-mono">{inv.invoice_number ? `#${inv.invoice_number}` : <span className="text-faint">—</span>}</td>
                      <td className="px-4 py-2.5 text-secondary whitespace-nowrap">{inv.invoice_date ? fmt(inv.invoice_date) : "—"}</td>
                      <td className="px-4 py-2.5 text-body">{inv.partner_name ?? inv.customer_name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-body">{inv.beer_name ?? "—"}</td>
                      <td className="px-4 py-2.5"><span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[inv.status] ?? STATUS_BADGE.unknown}`}>{STATUS_LABEL[inv.status] ?? inv.status}</span></td>
                      <td className="px-4 py-2.5 text-right text-strong font-medium tabular-nums">{fmtUsd(inv.total_cents / 100)}</td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-line bg-surface/20">
                        <td colSpan={7} className="p-0"><ExpandedPanel invoice={inv} /></td>
                      </tr>
                    )}
                  </React.Fragment>
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

- [ ] **Step 4: Verify build + lint**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify in the running app**

Start the dev server (preview tooling) and navigate to `/production/brewing/deposit-invoices`. Confirm: the "Deposit Invoices" subtab appears in the Brewing nav, the table renders, filters work, and expanding a row shows the frozen breakdown table with the Deposit Share column summing to the invoice total. (Rows appear once Task 5's backfill has been applied, or after generating a new deposit.)

- [ ] **Step 6: Commit**

```bash
git add app/production/nav-config.ts app/production/brewing/deposit-invoices/page.tsx app/production/components/DepositInvoicesTab.tsx
git commit -m "feat(deposit): Brewing > Deposit Invoices review subtab"
```

---

## Post-implementation (coordinated with user, not a code task)

1. **Apply the migration** (`20260709_deposit_invoice_ingredients.sql`) to prod after explicit OK + backup.
2. **Dry-run the backfill:** `POST /api/production/deposit-invoices/backfill` with body `{}` (signed in as admin) — review the returned `results[]` (each row's `sum_cents` vs `total_cents`) and `summary`.
3. **Apply the backfill:** same route with body `{ "apply": true }` after approval.
4. **Run the full test suite:** `npm run test` — confirm coverage stays above the `vitest.config.ts` floor.

---

## Self-Review Notes

- **Spec coverage:** persist-on-generate (Task 3), persist-on-mark_paid (Task 3), backfill via audit_log (Tasks 4+5), reconcile-to-total scaling (Task 2), one table attached to invoices (Task 1), Brewing subtab mirroring Export Invoices (Tasks 6+7), no provenance flags (Task 1 schema), immutable/replace-on-regenerate (Task 2 `snapshotDepositBreakdown` delete-then-insert). All covered.
- **Type consistency:** `BreakdownInput` (Task 2) consumed by Tasks 3, 4, 5; `snapshotDepositBreakdown` signature identical across Tasks 2 and 3; `DepositInvoiceListItem`/`DepositBreakdownLine` identical across Tasks 6 and 7; `AuditRow`/`RecipeIngredientNow`/`IngredientNow` defined Task 4, consumed Task 5.
- **Deferred verification:** the migration and backfill touch prod, so their execution is gated to the post-implementation section per the standing prod-DB rule — code tasks stop at type-check.
