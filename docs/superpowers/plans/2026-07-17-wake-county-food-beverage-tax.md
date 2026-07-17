# Wake County — Prepared Food & Beverage Tax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third tax-filing party — **Wake County — Prepared Food & Beverage Tax** (1% monthly, sourced from Square's dedicated catalog tax line) — to Finance → Taxes, as a pure plugin addition to the existing party-template registry.

**Architecture:** Follows the exact pattern by which Beer Excise (party #2) was added — a new `TaxPartyTemplate` registered server-side (`lib/tax/registry.ts`) and a worksheet component registered client-side (`app/finance/tax/parties/registry.ts`). Zero changes to the generic tax core (schedules, tasks, worksheet shell, settings pages, API routes, cron). One low-risk shared extraction: the Square-tax-line base fetcher `fetchTaxableBase` moves from `ncDorSalesUse/calc.ts` to a shared `lib/tax/squareTaxBase.ts` so both parties reuse it.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase Postgres, Vitest. Square catalog tax `ARI25PLSGLDVIBUQITKTRNSX` ("Prepared Food & Beverage Tax") already feeds the synced `pos_line_item_taxes` table.

**Execution Budget:** Mode = inline execution (executing-plans). Spawn cap = 6. Token target = moderate. This is ~13 tightly-coupled files across 4 locality groups following one precedent — inline execution avoids cold-context rebuild churn.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-17-wake-county-food-beverage-tax-design.md` (authoritative).
- **UI:** token utilities only (no raw `zinc/amber/red/...`), `.inp`/`.btn-*` primitives, type + spacing scales, per `docs/UI_STANDARD.md`. Money = `text-sm font-mono tabular-nums`, formatted via `fmtCents`.
- **Money:** all integer cents. Every rounding uses `Math.round` exactly once.
- **Tests:** new `lib/` logic ships with co-located `*.test.ts`. `npm run verify` (lint + typecheck + tests) is the definition of done.
- **Party key:** `wake_county_food_beverage`. **Rate key:** `wake_county_food_beverage_tax`. **Authority key:** `wake_county`. **Worksheet component key:** `wake_county_food_beverage`.
- **lib party dir:** `lib/tax/parties/wakeCountyFoodBeverage/` (camelCase, matches `ncDorSalesUse`). **Client UI dir:** `app/finance/tax/parties/WakeCountyFoodBeverage/` (PascalCase, matches `NcDorSalesUse`).
- **Migration is human-gated** — do NOT apply to prod. Create the file only.
- Worktree: run all commands from the worktree root; commit to branch `claude/wake-county-food-beverage-tax-6e5ff0`.

---

### Task 1: Data layer — migration + `prepared_food` category type

**Files:**
- Create: `supabase/migrations/20260803_wake_county_food_beverage_tax.sql`
- Modify: `lib/tax/rates.ts:16` (add `"prepared_food"` to the `TaxRate.category` union)

**Interfaces:**
- Produces: `tax_authorities` row `wake_county`; `tax_rates` row keyed `wake_county_food_beverage_tax` (category `prepared_food`, basis `percent`, rate `0.01`). `TaxRate.category` now includes `"prepared_food"`.

- [ ] **Step 1: Create the migration file**

`supabase/migrations/20260803_wake_county_food_beverage_tax.sql`:

```sql
-- Wake County — Prepared Food & Beverage Tax (tax party #3)
--
-- Adds the wake_county authority and the 1% prepared-food-&-beverage rate to
-- the canonical registries so the new party template (lib/tax/parties/
-- wakeCountyFoodBeverage) resolves its authority + rate. Pure data seed, no
-- DDL: tax_rates.category has NO check constraint, so the new 'prepared_food'
-- category needs no constraint change. Idempotent via `on conflict do nothing`.
--
-- Human-gated (do not auto-apply).

insert into public.tax_authorities (key, label, display_order)
values ('wake_county', 'Wake County Department of Tax Administration', 4)
on conflict (key) do nothing;

insert into public.tax_rates (key, name, category, party_key, basis, rate, is_active)
values (
  'wake_county_food_beverage_tax',
  'Wake County Prepared Food & Beverage Tax',
  'prepared_food',
  'wake_county',
  'percent',
  0.01,
  true
)
on conflict (key) do nothing;
```

- [ ] **Step 2: Add `prepared_food` to the `TaxRate.category` union**

In `lib/tax/rates.ts`, change line 16 from:

```ts
  category: "excise" | "sales" | "local" | "transit";
```

to:

```ts
  category: "excise" | "sales" | "local" | "transit" | "prepared_food";
```

- [ ] **Step 3: Typecheck**

Run: `npm run verify`
Expected: PASS (the union widening is additive; no call site breaks). If `verify` is heavy, `npx tsc --noEmit` is a faster proxy for this step.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260803_wake_county_food_beverage_tax.sql lib/tax/rates.ts
git commit -m "feat(tax): seed Wake County authority + food-beverage rate (migration + category type)"
```

---

### Task 2: Extract `fetchTaxableBase` to shared `lib/tax/squareTaxBase.ts`

**Files:**
- Create: `lib/tax/squareTaxBase.ts`
- Create: `lib/tax/squareTaxBase.test.ts`
- Modify: `lib/tax/parties/ncDorSalesUse/calc.ts` (import from the shared module; keep the re-export; drop now-unused imports)

**Interfaces:**
- Produces: `fetchTaxableBase(sb: SupabaseClient, squareTaxId: string, period: TaxPeriod, pageSize?: number): Promise<{ baseCents: number; collectedCents: number }>` — importable from `@/lib/tax/squareTaxBase`.
- Consumes: `fetchAllRows` (`@/lib/supabase/paginate`), `addDaysStr` (`@/lib/utils/datetime`), `TaxPeriod` (`@/lib/tax/types`).

- [ ] **Step 1: Write the failing test**

`lib/tax/squareTaxBase.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTaxableBase } from "./squareTaxBase";

interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: { net_sales_cents: number; tax_cents: number };
}

/** Stub Supabase routing `pos_line_item_taxes` via the paged
 * `.select().eq().gte().lt().order().range(from,to)` chain `fetchAllRows` drives. */
function stubSb(rows: TaxRow[], error?: string): SupabaseClient {
  const from = (table: string) => {
    if (table !== "pos_line_item_taxes") throw new Error(`unexpected table: ${table}`);
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.gte = () => b;
    b.lt = () => b;
    b.order = () => b;
    b.range = (fromIdx: number, toIdx: number) =>
      Promise.resolve(
        error
          ? { data: null, error: { message: error } }
          : { data: rows.slice(fromIdx, toIdx + 1), error: null },
      );
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-20" };

describe("fetchTaxableBase", () => {
  it("sums base (net - tax) and collected (amount), deduping by line_item_id", async () => {
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725 } },
      { line_item_id: "B", amount_cents: 363, pos_line_items: { net_sales_cents: 5000, tax_cents: 363 } },
      { line_item_id: "A", amount_cents: 725, pos_line_items: { net_sales_cents: 10000, tax_cents: 725 } },
    ];
    const res = await fetchTaxableBase(stubSb(rows), "TAX_FB", period);
    expect(res.baseCents).toBe(10000 - 725 + (5000 - 363));
    expect(res.collectedCents).toBe(725 + 363);
  });

  it("pages through the whole result set — no PostgREST 1000-row truncation", async () => {
    const rows: TaxRow[] = [
      { line_item_id: "A", amount_cents: 100, pos_line_items: { net_sales_cents: 1000, tax_cents: 100 } },
      { line_item_id: "B", amount_cents: 200, pos_line_items: { net_sales_cents: 2000, tax_cents: 200 } },
      { line_item_id: "C", amount_cents: 300, pos_line_items: { net_sales_cents: 3000, tax_cents: 300 } },
    ];
    const res = await fetchTaxableBase(stubSb(rows), "TAX_FB", period, 2);
    expect(res.baseCents).toBe(1000 - 100 + (2000 - 200) + (3000 - 300));
    expect(res.collectedCents).toBe(600);
  });

  it("returns zeros when no rows match", async () => {
    const res = await fetchTaxableBase(stubSb([]), "TAX_FB", period);
    expect(res).toEqual({ baseCents: 0, collectedCents: 0 });
  });

  it("throws on query error", async () => {
    await expect(fetchTaxableBase(stubSb([], "boom"), "TAX_FB", period)).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/tax/squareTaxBase.test.ts`
Expected: FAIL — cannot find module `./squareTaxBase`.

- [ ] **Step 3: Create the shared module**

`lib/tax/squareTaxBase.ts` (the body is `fetchTaxableBase` moved verbatim from `ncDorSalesUse/calc.ts`, with the param renamed `generalSalesTaxId` → `squareTaxId` since it is now generic):

```ts
/**
 * Shared Square tax-line base fetcher — one Square catalog tax's taxable base
 * and collected amount for a period, from synced POS data.
 *
 * Extracted from lib/tax/parties/ncDorSalesUse/calc.ts so more than one party
 * (NC DOR Sales & Use, Wake County Prepared Food & Beverage) shares the
 * identical join without importing across a sibling party's internals.
 *
 * Joins pos_line_item_taxes (filtered to one square_tax_id) -> pos_line_items
 * -> square_orders, ranged over transaction_date. Filtering to one tax id
 * yields exactly one tax row per qualifying line, so a single pass gives per
 * line: base = net_sales_cents - tax_cents (post-discount, pre-tax receipts),
 * collected = amount_cents. Dedupes by line_item_id. Paged via fetchAllRows to
 * dodge PostgREST's 1000-row cap. pageSize is injectable for tests only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysStr } from "@/lib/utils/datetime";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { TaxPeriod } from "@/lib/tax/types";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

interface TaxJoinRow {
  line_item_id: string;
  amount_cents: number | null;
  pos_line_items:
    | { net_sales_cents: number | null; tax_cents: number | null }
    | { net_sales_cents: number | null; tax_cents: number | null }[]
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

  const data = await fetchAllRows<TaxJoinRow>(
    () =>
      sb
        .from("pos_line_item_taxes")
        .select(
          "line_item_id, amount_cents, pos_line_items!inner ( net_sales_cents, tax_cents, square_orders!inner ( transaction_date ) )",
        )
        .eq("square_tax_id", squareTaxId)
        .gte("pos_line_items.square_orders.transaction_date", startTs)
        .lt("pos_line_items.square_orders.transaction_date", endExclusiveTs)
        .order("line_item_id", { ascending: true }),
    pageSize,
  );

  const seen = new Set<string>();
  let baseCents = 0;
  let collectedCents = 0;
  for (const row of data) {
    if (seen.has(row.line_item_id)) continue;
    seen.add(row.line_item_id);
    const pliRaw = row.pos_line_items;
    const pli = Array.isArray(pliRaw) ? pliRaw[0] : pliRaw;
    if (!pli) continue;
    baseCents += num(pli.net_sales_cents) - num(pli.tax_cents);
    collectedCents += num(row.amount_cents);
  }
  return { baseCents, collectedCents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/tax/squareTaxBase.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewire `ncDorSalesUse/calc.ts` to the shared module**

In `lib/tax/parties/ncDorSalesUse/calc.ts`:

1. **Delete** the local `fetchTaxableBase` function definition (the `export async function fetchTaxableBase(...)` block) and the `interface TaxJoinRow { ... }` above it.
2. **Add** an import + back-compat re-export near the top imports:

```ts
import { fetchTaxableBase } from "@/lib/tax/squareTaxBase";
// Back-compat: existing import sites and tests import fetchTaxableBase from "./calc".
export { fetchTaxableBase };
```

3. **Remove** the now-unused imports `addDaysStr` (from `@/lib/utils/datetime`) and `fetchAllRows` (from `@/lib/supabase/paginate`) — they were only used by the moved function. Keep the `SupabaseClient` type import (still used by `computeNcDorWorksheet`).
4. The existing call site inside `computeNcDorWorksheet` — `fetchTaxableBase(client, generalSalesTaxId, ctx.period)` — is unchanged (positional args).

- [ ] **Step 6: Run the full tax suite to verify nothing regressed**

Run: `npx vitest run lib/tax/`
Expected: PASS — including the existing `ncDorSalesUse/calc.test.ts` `fetchTaxableBase` cases (now exercising the re-export) and `computeNcDorWorksheet` glue.

- [ ] **Step 7: Commit**

```bash
git add lib/tax/squareTaxBase.ts lib/tax/squareTaxBase.test.ts lib/tax/parties/ncDorSalesUse/calc.ts
git commit -m "refactor(tax): extract fetchTaxableBase to shared lib/tax/squareTaxBase"
```

---

### Task 3: Wake party pure modules — `rates.ts` + `fieldOwnership.ts`

**Files:**
- Create: `lib/tax/parties/wakeCountyFoodBeverage/rates.ts`
- Create: `lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.ts`
- Create: `lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.test.ts`

**Interfaces:**
- Produces: `WAKE_FB_RATE_KEY: string`, `WAKE_FB_RATE_FALLBACK: number` (`0.01`), `WAKE_FB_REFERENCE: ReferenceSpec`; `resolveWakeFieldOwnership(key: string): FieldOwnership`, `isComputedField(key: string): boolean`.
- Both files have ZERO server imports (client-safe), so the client bundle and server template resolve identically — mirrors `ncDorBeerExcise/rates.ts` + `fieldOwnership.ts`.

- [ ] **Step 1: Create `rates.ts`**

`lib/tax/parties/wakeCountyFoodBeverage/rates.ts`:

```ts
/**
 * Wake County — Prepared Food & Beverage Tax — statutory rate + reference.
 *
 * Zero server imports so this stays importable by both the pure
 * ./fieldOwnership.ts module (client-safe) and the server ./calc.ts / ./template.ts.
 */
import type { ReferenceSpec } from "@/lib/tax/types";

/** Canonical tax_rates key for the Wake County prepared food & beverage rate. */
export const WAKE_FB_RATE_KEY = "wake_county_food_beverage_tax";

/** Statutory 1% rate — fallback used only when the tax_rates row is missing. */
export const WAKE_FB_RATE_FALLBACK = 0.01;

export const WAKE_FB_REFERENCE: ReferenceSpec = {
  tables: [
    {
      title: "Rate",
      columns: ["Rate", "Applies to"],
      rows: [["1.00%", "Applicable prepared food & beverage gross receipts"]],
    },
  ],
  notes: [
    "Filed monthly; due the 20th of the following month.",
    "1% of the sale price of prepared food and beverages sold at retail in Wake County (effective January 1, 1993), in addition to NC state sales tax.",
    "Applicable Gross Receipts = net sales of items carrying the Square Prepared Food & Beverage Tax line.",
    "The rate is read from the canonical tax_rates row (key wake_county_food_beverage_tax); the statutory 1% is used as a fallback only if that row is missing.",
  ],
};
```

- [ ] **Step 2: Write the failing field-ownership test**

`lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveWakeFieldOwnership, isComputedField } from "./fieldOwnership";

describe("resolveWakeFieldOwnership", () => {
  it("marks every worksheet figure computed", () => {
    for (const key of [
      "wake_gross_receipts_cents",
      "wake_applicable_receipts_cents",
      "wake_tax_owed_cents",
      "wake_collected_fb_cents",
      "wake_rate",
    ]) {
      expect(resolveWakeFieldOwnership(key)).toBe("computed");
      expect(isComputedField(key)).toBe(true);
    }
  });

  it("defaults unknown keys to manual", () => {
    expect(resolveWakeFieldOwnership("something_else")).toBe("manual");
    expect(isComputedField("something_else")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.test.ts`
Expected: FAIL — cannot find module `./fieldOwnership`.

- [ ] **Step 4: Create `fieldOwnership.ts`**

`lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.ts`:

```ts
/**
 * Wake County F&B worksheet field ownership — the single source of truth for
 * which worksheet keys are server-computed. Every field is computed (the
 * worksheet has no manual inputs), so the whole set is read-only on the
 * worksheet and fully replaced by each recompute.
 *
 * Zero server imports — only @/lib/tax/types (erased at compile time) — so both
 * the server ./template.ts (via its Proxy) and the client re-export resolve
 * ownership identically.
 */
import type { FieldOwnership } from "@/lib/tax/types";

const COMPUTED_KEYS = new Set([
  "wake_gross_receipts_cents",
  "wake_applicable_receipts_cents",
  "wake_tax_owed_cents",
  "wake_collected_fb_cents",
  "wake_rate",
]);

export function resolveWakeFieldOwnership(key: string): FieldOwnership {
  return COMPUTED_KEYS.has(key) ? "computed" : "manual";
}

export function isComputedField(key: string): boolean {
  return resolveWakeFieldOwnership(key) === "computed";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/tax/parties/wakeCountyFoodBeverage/rates.ts lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.ts lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership.test.ts
git commit -m "feat(tax): Wake County F&B rates + field-ownership modules"
```

---

### Task 4: Wake party calc engine — `calc.ts`

**Files:**
- Create: `lib/tax/parties/wakeCountyFoodBeverage/calc.ts`
- Create: `lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts`

**Interfaces:**
- Consumes: `fetchTaxableBase` (`@/lib/tax/squareTaxBase`, Task 2), `getTaxRate` (`@/lib/tax/rates`), `WAKE_FB_RATE_KEY` / `WAKE_FB_RATE_FALLBACK` (Task 3), `ComputeContext` / `WorksheetData` / `WorksheetFields` (`@/lib/tax/types`).
- Produces: `computeWakeFigures(args: ComputeWakeFiguresArgs): WorksheetData` (pure) and `computeWakeWorksheet(ctx: ComputeContext, sb?: SupabaseClient): Promise<WorksheetData>` (glue). Fields produced: `wake_gross_receipts_cents` (number | null), `wake_applicable_receipts_cents`, `wake_tax_owed_cents`, `wake_collected_fb_cents`, `wake_rate`.

- [ ] **Step 1: Write the failing test**

`lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext } from "@/lib/tax/types";
import { computeWakeFigures, computeWakeWorksheet } from "./calc";

describe("computeWakeFigures", () => {
  it("tax owed = round(applicable x rate); no warning when it matches collected", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: 500000,
      applicableReceiptsCents: 300000,
      collectedFbCents: 3000,
      rate: 0.01,
    });
    expect(ws.fields.wake_gross_receipts_cents).toBe(500000);
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000);
    expect(ws.fields.wake_tax_owed_cents).toBe(3000); // round(300000 * 0.01)
    expect(ws.fields.wake_rate).toBe(0.01);
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("gross receipts is null when the general sales tax id is unconfigured", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: null,
      applicableReceiptsCents: 300000,
      collectedFbCents: 3000,
      rate: 0.01,
    });
    expect(ws.fields.wake_gross_receipts_cents).toBeNull();
  });

  it("warns when computed tax diverges from Square-collected beyond tolerance", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: 500000,
      applicableReceiptsCents: 300000, // -> 3000
      collectedFbCents: 5000,          // diff 2000 >> tolerance
      rate: 0.01,
    });
    expect(ws.warnings?.length).toBe(1);
    expect(ws.warnings?.[0]).toMatch(/differs from Square-collected/);
  });

  it("stays silent within the rounding tolerance (max(100, 0.1% of collected))", () => {
    const ws = computeWakeFigures({
      grossReceiptsCents: null,
      applicableReceiptsCents: 300000, // -> 3000
      collectedFbCents: 3050,          // diff 50 <= 100 tolerance
      rate: 0.01,
    });
    expect(ws.warnings ?? []).toEqual([]);
  });
});

// ── DB glue (stubbed sb) ─────────────────────────────────────────────────────

interface TaxRow {
  line_item_id: string;
  amount_cents: number;
  pos_line_items: { net_sales_cents: number; tax_cents: number };
}

/** Routes pos_line_item_taxes per captured square_tax_id, and tax_rates for getTaxRate. */
function stubSb(opts: { rowsByTaxId: Record<string, TaxRow[]>; rate?: number | null }): SupabaseClient {
  const from = (table: string) => {
    if (table === "tax_rates") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () =>
        Promise.resolve({ data: opts.rate == null ? null : { rate: opts.rate }, error: null });
      return b;
    }
    if (table !== "pos_line_item_taxes") throw new Error(`unexpected table: ${table}`);
    let taxId = "";
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (_col: string, val: string) => {
      taxId = val;
      return b;
    };
    b.gte = () => b;
    b.lt = () => b;
    b.order = () => b;
    b.range = (fromIdx: number, toIdx: number) =>
      Promise.resolve({ data: (opts.rowsByTaxId[taxId] ?? []).slice(fromIdx, toIdx + 1), error: null });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-20" };

function ctxWith(profile: Record<string, string>): ComputeContext {
  return {
    schedule: {
      id: "s1",
      party_key: "wake_county_food_beverage",
      frequency: "monthly",
      lead_days: 10,
      active: true,
      config: {},
      created_at: "",
      updated_at: "",
    },
    profile,
    period,
  };
}

describe("computeWakeWorksheet", () => {
  it("computes applicable + gross from their own tax ids and the tax_rates rate", async () => {
    const sb = stubSb({
      rowsByTaxId: {
        TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }],
        TAX_GEN: [{ line_item_id: "A", amount_cents: 23750, pos_line_items: { net_sales_cents: 523750, tax_cents: 23750 } }],
      },
      rate: 0.01,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB", general_sales_tax_id: "TAX_GEN" }), sb);
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000); // 303000 - 3000
    expect(ws.fields.wake_gross_receipts_cents).toBe(500000);      // 523750 - 23750
    expect(ws.fields.wake_tax_owed_cents).toBe(3000);              // round(300000 * 0.01)
    expect(ws.warnings ?? []).toEqual([]);
  });

  it("gross receipts null when general_sales_tax_id is blank", async () => {
    const sb = stubSb({
      rowsByTaxId: { TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }] },
      rate: 0.01,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB" }), sb);
    expect(ws.fields.wake_gross_receipts_cents).toBeNull();
    expect(ws.fields.wake_applicable_receipts_cents).toBe(300000);
  });

  it("falls back to the statutory 1% and warns when no tax_rates row exists", async () => {
    const sb = stubSb({
      rowsByTaxId: { TAX_FB: [{ line_item_id: "A", amount_cents: 3000, pos_line_items: { net_sales_cents: 303000, tax_cents: 3000 } }] },
      rate: null,
    });
    const ws = await computeWakeWorksheet(ctxWith({ food_beverage_tax_id: "TAX_FB" }), sb);
    expect(ws.fields.wake_rate).toBe(0.01);
    expect(ws.warnings?.some((w) => /statutory fallback/.test(w))).toBe(true);
  });

  it("returns only a warning when food_beverage_tax_id is unconfigured", async () => {
    const sb = stubSb({ rowsByTaxId: {}, rate: 0.01 });
    const ws = await computeWakeWorksheet(ctxWith({}), sb);
    expect(ws.fields).toEqual({});
    expect(ws.warnings?.[0]).toMatch(/No Square Prepared Food & Beverage Tax configured/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts`
Expected: FAIL — cannot find module `./calc`.

- [ ] **Step 3: Create `calc.ts`**

`lib/tax/parties/wakeCountyFoodBeverage/calc.ts`:

```ts
/**
 * Wake County — Prepared Food & Beverage Tax — calculation engine.
 *
 *  - computeWakeFigures      — pure worksheet builder: tax owed = round(
 *    applicable receipts x rate), plus a reconciliation warning when the
 *    computed tax diverges from what Square actually collected on the F&B line.
 *  - computeWakeWorksheet    — glue: reads the two Square tax ids from the
 *    profile, pulls each base via the shared fetchTaxableBase, reads the rate
 *    from tax_rates (statutory 1% fallback), and assembles the field set.
 *
 * Gross Receipts uses the SAME logic as NC DOR Sales & Use (net_sales - tax on
 * the general sales tax line); it is display-only and never reconciled. Only
 * the F&B line is reconciled. All money is integer cents; the single rounding
 * is Math.round on the tax-owed line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComputeContext, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { getTaxRate } from "@/lib/tax/rates";
import { fetchTaxableBase } from "@/lib/tax/squareTaxBase";
import { WAKE_FB_RATE_KEY, WAKE_FB_RATE_FALLBACK } from "./rates";

export interface ComputeWakeFiguresArgs {
  grossReceiptsCents: number | null; // null when general_sales_tax_id is unset
  applicableReceiptsCents: number;
  collectedFbCents: number;
  rate: number; // e.g. 0.01
}

export function computeWakeFigures(args: ComputeWakeFiguresArgs): WorksheetData {
  const { grossReceiptsCents, applicableReceiptsCents, collectedFbCents, rate } = args;
  const warnings: string[] = [];

  const taxOwedCents = Math.round(applicableReceiptsCents * rate);

  const fields: WorksheetFields = {
    wake_gross_receipts_cents: grossReceiptsCents,
    wake_applicable_receipts_cents: applicableReceiptsCents,
    wake_tax_owed_cents: taxOwedCents,
    wake_collected_fb_cents: collectedFbCents,
    wake_rate: rate,
  };

  // Reconciliation (F&B line only): Square rounds tax per transaction while
  // this computes on the aggregate monthly base, so a normal month drifts by a
  // few cents with no misconfiguration. Tolerance = 0.1% of collected, floored
  // at 100 cents, so ordinary rounding never fires while a genuine mismatch does.
  const tolerance = Math.max(100, Math.round(collectedFbCents * 0.001));
  const diff = Math.abs(taxOwedCents - collectedFbCents);
  if (diff > tolerance) {
    warnings.push(
      `Computed Wake County tax (${taxOwedCents}¢) differs from Square-collected (${collectedFbCents}¢) by ${diff}¢, exceeding the ${tolerance}¢ rounding tolerance. Review before filing.`,
    );
  }

  const result: WorksheetData = {
    fields,
    meta: { computedAt: new Date().toISOString(), provenance: "square" },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

export async function computeWakeWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
): Promise<WorksheetData> {
  const foodBeverageTaxId = ctx.profile.food_beverage_tax_id;
  const generalSalesTaxId = ctx.profile.general_sales_tax_id;

  if (!foodBeverageTaxId) {
    return {
      fields: {},
      warnings: [
        "No Square Prepared Food & Beverage Tax configured (profile.food_beverage_tax_id is empty). Set it in Tax settings before recomputing.",
      ],
      meta: { computedAt: new Date().toISOString(), provenance: "square" },
    };
  }

  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [applicable, gross, rateFromDb] = await Promise.all([
    fetchTaxableBase(client, foodBeverageTaxId, ctx.period),
    generalSalesTaxId ? fetchTaxableBase(client, generalSalesTaxId, ctx.period) : Promise.resolve(null),
    getTaxRate(client, WAKE_FB_RATE_KEY),
  ]);

  const rate =
    rateFromDb != null && Number.isFinite(rateFromDb) && rateFromDb > 0 ? rateFromDb : WAKE_FB_RATE_FALLBACK;

  const result = computeWakeFigures({
    grossReceiptsCents: gross ? gross.baseCents : null,
    applicableReceiptsCents: applicable.baseCents,
    collectedFbCents: applicable.collectedCents,
    rate,
  });

  if (rateFromDb == null) {
    result.warnings = [
      `No active Wake County food & beverage rate configured — using the statutory fallback (${(WAKE_FB_RATE_FALLBACK * 100).toFixed(2)}%). Set the rate in the tax_rates registry.`,
      ...(result.warnings ?? []),
    ];
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tax/parties/wakeCountyFoodBeverage/calc.ts lib/tax/parties/wakeCountyFoodBeverage/calc.test.ts
git commit -m "feat(tax): Wake County F&B calc engine (figures + Square glue)"
```

---

### Task 5: Wake party template + registration

**Files:**
- Create: `lib/tax/parties/wakeCountyFoodBeverage/template.ts`
- Create: `lib/tax/parties/wakeCountyFoodBeverage/template.test.ts`
- Modify: `lib/tax/parties/index.ts` (add the side-effect import)

**Interfaces:**
- Consumes: `computeWakeWorksheet` (Task 4), `resolveWakeFieldOwnership` (Task 3), `WAKE_FB_RATE_KEY` / `WAKE_FB_REFERENCE` (Task 3), `monthPeriod` (`@/lib/tax/period`), `resolveDueDate` / `DueRule` (`@/lib/tax/dueDate`), `registerParty` (`@/lib/tax/registry`), `RequiredRegistration` (`@/lib/tax/registrations`).
- Produces: registers `wakeCountyFoodBeverageTemplate` (key `wake_county_food_beverage`) so `getParty("wake_county_food_beverage")` resolves after `import "@/lib/tax/parties"`.

- [ ] **Step 1: Write the failing test**

`lib/tax/parties/wakeCountyFoodBeverage/template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { wakeCountyFoodBeverageTemplate as t } from "./template";

describe("wakeCountyFoodBeverageTemplate", () => {
  it("declares monthly cadence due the 20th of the following month", () => {
    expect(t.supportedFrequencies).toEqual(["monthly"]);
    expect(t.defaultDueRule("monthly")).toEqual({ monthOffset: 1, day: 20 });
    const p = t.computePeriod("monthly", new Date("2026-07-15T12:00:00Z"));
    expect(p.start).toBe("2026-07-01");
    expect(p.end).toBe("2026-07-31");
    expect(p.due).toBe("2026-08-20");
  });

  it("rejects unsupported frequencies", () => {
    expect(() => t.defaultDueRule("quarterly")).toThrow();
  });

  it("declares the required Wake County account registration", () => {
    expect(t.requiredRegistrations).toContainEqual({
      authorityKey: "wake_county",
      registrationKey: "wake_county_account_id",
      label: "Wake County Gross Receipts Account Number",
    });
  });

  it("exposes the two Square-tax selects and the sensitive PIN in settingsSchema", () => {
    const keys = t.settingsSchema.map((f) => f.key);
    expect(keys).toEqual(["food_beverage_tax_id", "general_sales_tax_id", "filing_pin"]);
    const fb = t.settingsSchema.find((f) => f.key === "food_beverage_tax_id");
    expect(fb?.type).toBe("select");
    expect(fb?.required).toBe(true);
    const pin = t.settingsSchema.find((f) => f.key === "filing_pin");
    expect(pin?.type).toBe("text");
    expect(pin?.sensitive).toBe(true);
  });

  it("mergeWorksheet fully replaces fields with the recompute (all fields computed)", () => {
    const current = { fields: { wake_tax_owed_cents: 111, stray: "keep?" } };
    const recomputed = { fields: { wake_tax_owed_cents: 222 }, meta: { computedAt: "t" } };
    const merged = t.mergeWorksheet(current, recomputed, {});
    expect(merged.fields).toEqual({ wake_tax_owed_cents: 222 });
  });

  it("buildReferenceView renders the live rate when present", () => {
    const ref = t.buildReferenceView({ wake_county_food_beverage_tax: 0.01 });
    expect(ref.tables[0].rows[0][0]).toBe("1.00%");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/template.test.ts`
Expected: FAIL — cannot find module `./template`.

- [ ] **Step 3: Create `template.ts`**

`lib/tax/parties/wakeCountyFoodBeverage/template.ts`:

```ts
/**
 * Wake County — Prepared Food & Beverage Tax — party template.
 *
 * Assembles the TaxPartyTemplate and registers it so
 * getParty("wake_county_food_beverage") resolves anywhere in the app. Monthly
 * only; due the 20th of the following month. Every worksheet field is computed
 * (no manual inputs), so mergeWorksheet fully replaces the field set with the
 * recompute. Filer identity (contact person, address) comes from the shared
 * Tax Profile (tax_legal_representative / tax_entity_profile) via
 * TaxWorksheetShell's IdentityHeader; the Wake County account # is a required
 * registration and the 4-digit PIN is a sensitive settings field.
 */
import type {
  ComputeContext,
  FieldOwnership,
  FieldSpec,
  Frequency,
  ReferenceSpec,
  TaxPartyTemplate,
  TaxPeriod,
  WorksheetData,
} from "@/lib/tax/types";
import { monthPeriod } from "@/lib/tax/period";
import { resolveDueDate, type DueRule } from "@/lib/tax/dueDate";
import { registerParty } from "@/lib/tax/registry";
import type { RequiredRegistration } from "@/lib/tax/registrations";
import { computeWakeWorksheet } from "./calc";
import { resolveWakeFieldOwnership } from "./fieldOwnership";
import { WAKE_FB_RATE_KEY, WAKE_FB_REFERENCE } from "./rates";

function defaultDueRule(freq: Frequency): DueRule {
  if (freq === "monthly") return { monthOffset: 1, day: 20 };
  throw new Error(`wake_county_food_beverage does not support frequency: ${freq}`);
}

function computePeriod(freq: Frequency, ref: Date): TaxPeriod {
  if (freq !== "monthly") throw new Error(`wake_county_food_beverage does not support frequency: ${freq}`);
  const { start, end } = monthPeriod(ref);
  return { start, end, due: resolveDueDate(end, defaultDueRule(freq)) };
}

export { resolveWakeFieldOwnership } from "./fieldOwnership";

const fieldOwnership: Record<string, FieldOwnership> = new Proxy({} as Record<string, FieldOwnership>, {
  get: (_target, prop) => (typeof prop === "string" ? resolveWakeFieldOwnership(prop) : undefined),
});

// Every field is computed — nothing manual to preserve — so a recompute fully
// replaces the field set. `rateMap` is accepted for interface parity but unused
// (the rate is read directly in ./calc.ts).
function mergeWorksheet(
  _current: WorksheetData,
  recomputed: WorksheetData,
  _rateMap: Record<string, number>,
): WorksheetData {
  return { fields: { ...recomputed.fields }, warnings: recomputed.warnings, meta: recomputed.meta };
}

const settingsSchema: FieldSpec[] = [
  {
    key: "food_beverage_tax_id",
    label: "Square Prepared Food & Beverage Tax",
    type: "select",
    required: true,
    help: "The Square catalog tax representing the Wake County Prepared Food & Beverage Tax. Drives Applicable Gross Receipts and Tax Owed. Options are fetched from Square's catalog taxes.",
  },
  {
    key: "general_sales_tax_id",
    label: "Square General Sales Tax (for Gross Receipts)",
    type: "select",
    help: "Optional — the Square general sales tax, used only to show the Gross Receipts comparison row. Leave blank to omit that row.",
  },
  {
    key: "filing_pin",
    label: "Wake County Filing PIN",
    type: "text",
    sensitive: true,
    help: "The 4-digit PIN required to submit the Wake County return. Stored securely and never displayed after saving.",
  },
];

const scheduleConfigSchema: FieldSpec[] = [];

function buildReferenceView(rateMap: Record<string, number>): ReferenceSpec {
  const rate = rateMap[WAKE_FB_RATE_KEY];
  if (rate == null) return WAKE_FB_REFERENCE;
  return {
    ...WAKE_FB_REFERENCE,
    tables: [
      {
        ...WAKE_FB_REFERENCE.tables[0],
        rows: [[`${(rate * 100).toFixed(2)}%`, "Applicable prepared food & beverage gross receipts"]],
      },
    ],
  };
}

const requiredRegistrations: RequiredRegistration[] = [
  {
    authorityKey: "wake_county",
    registrationKey: "wake_county_account_id",
    label: "Wake County Gross Receipts Account Number",
  },
];

export const wakeCountyFoodBeverageTemplate: TaxPartyTemplate = {
  key: "wake_county_food_beverage",
  label: "Wake County — Prepared Food & Beverage Tax",
  supportedFrequencies: ["monthly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeWakeWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from Square",
  worksheetComponent: "wake_county_food_beverage",
};

registerParty(wakeCountyFoodBeverageTemplate);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/tax/parties/wakeCountyFoodBeverage/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the party in the side-effect index**

In `lib/tax/parties/index.ts`, add after the existing two imports:

```ts
import "./wakeCountyFoodBeverage/template";
```

- [ ] **Step 6: Run the full tax suite**

Run: `npx vitest run lib/tax/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/tax/parties/wakeCountyFoodBeverage/template.ts lib/tax/parties/wakeCountyFoodBeverage/template.test.ts lib/tax/parties/index.ts
git commit -m "feat(tax): register Wake County F&B party template"
```

---

### Task 6: Client worksheet UI + registry wiring

**Files:**
- Create: `app/finance/tax/parties/WakeCountyFoodBeverage/Worksheet.tsx`
- Create: `app/finance/tax/parties/WakeCountyFoodBeverage/fieldOwnership.ts`
- Modify: `app/finance/tax/parties/registry.ts` (add the `wake_county_food_beverage` module entry)

**Interfaces:**
- Consumes: `PartyWorksheetProps` (`../registry`), `fmtCents` (`@/lib/utils/formatting`), `resolveWakeFieldOwnership` / `isComputedField` (`@/lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership`, Task 3).
- Produces: default export `WakeCountyFoodBeverageWorksheet`; `getTotalDueCents(fields)` reading `wake_tax_owed_cents`; registry key `wake_county_food_beverage`.

- [ ] **Step 1: Create the client field-ownership re-export**

`app/finance/tax/parties/WakeCountyFoodBeverage/fieldOwnership.ts`:

```ts
/**
 * Client-side re-export of the Wake County F&B field-ownership rule. The single
 * source of truth is the pure lib/tax/parties/wakeCountyFoodBeverage/
 * fieldOwnership.ts module (zero server imports), so the client bundle and the
 * server template resolve ownership identically.
 */
export {
  resolveWakeFieldOwnership,
  isComputedField,
} from "@/lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership";

/** Reads Tax Owed (cents) off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.wake_tax_owed_cents;
  return v == null ? null : Number(v);
}
```

- [ ] **Step 2: Create the worksheet component**

`app/finance/tax/parties/WakeCountyFoodBeverage/Worksheet.tsx`:

```tsx
"use client";

/**
 * Wake County — Prepared Food & Beverage Tax worksheet — a read-only three-row
 * summary. Every figure is server-computed (see the party's fieldOwnership), so
 * there are no editable inputs: the component only displays the current fields.
 *
 * Filer identity (contact person, Wake County account #, address) is NOT
 * rendered here — it's shown once, above every party's worksheet, by
 * TaxWorksheetShell's IdentityHeader (sourced from the shared Tax Profile). The
 * 4-digit PIN is a masked settings field, never displayed on the worksheet.
 *
 * Gross Receipts shows "—" when the optional general-sales-tax mapping is unset.
 */
import { fmtCents } from "@/lib/utils/formatting";
import type { PartyWorksheetProps } from "../registry";

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

export default function WakeCountyFoodBeverageWorksheet({ fields }: PartyWorksheetProps) {
  const grossRaw = fields.wake_gross_receipts_cents;
  const gross = grossRaw == null ? null : num(grossRaw);
  const applicable = num(fields.wake_applicable_receipts_cents);
  const taxOwed = num(fields.wake_tax_owed_cents);
  const rate = num(fields.wake_rate);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="border border-line rounded px-3 py-2 mb-1">
          <h4 className="text-sm font-bold text-strong">Wake County Prepared Food &amp; Beverage Tax</h4>
        </div>
        <Row label="Gross Receipts (Taproom Net Sales)" value={gross == null ? "—" : fmtCents(gross)} />
        <Row label="Applicable Gross Receipts (Food &amp; Beverage-taxed items)" value={fmtCents(applicable)} />
        <Row label={`Tax Owed (${(rate * 100).toFixed(2)}%)`} value={fmtCents(taxOwed)} emphasis />
      </section>
    </div>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      <span className={`text-sm font-mono tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
        {value}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Wire the module into the client registry**

In `app/finance/tax/parties/registry.ts`:

1. Add imports alongside the existing party imports:

```ts
import WakeCountyFoodBeverageWorksheet from "./WakeCountyFoodBeverage/Worksheet";
import { getTotalDueCents as wakeCountyFoodBeverageTotalDueCents } from "./WakeCountyFoodBeverage/fieldOwnership";
```

2. Add an entry to `WORKSHEET_MODULES`:

```ts
  wake_county_food_beverage: {
    Worksheet: WakeCountyFoodBeverageWorksheet,
    getTotalDueCents: wakeCountyFoodBeverageTotalDueCents,
  },
```

- [ ] **Step 4: Typecheck + build the client**

Run: `npm run verify`
Expected: PASS (lint + typecheck + full test suite). Confirms the new client module compiles and imports resolve.

- [ ] **Step 5: Commit**

```bash
git add app/finance/tax/parties/WakeCountyFoodBeverage/ app/finance/tax/parties/registry.ts
git commit -m "feat(tax): Wake County F&B worksheet UI + client registry wiring"
```

---

### Task 7: Full verification + manual QA notes

**Files:** none (verification only)

- [ ] **Step 1: Run the full definition-of-done gate**

Run: `npm run verify`
Expected: PASS — lint, typecheck, and all tests green (including the new `squareTaxBase`, `fieldOwnership`, `calc`, and `template` suites and the unchanged NC DOR / Beer Excise suites).

- [ ] **Step 2: Browser smoke test (dev server via the preview tool)**

Verify in the running app (do not ask the user to check manually):
1. Finance → Settings → Tax Filing → select **Wake County — Prepared Food & Beverage Tax**: three settings fields render (two Square-tax selects populated from the live catalog, one masked PIN); the Reference table shows the 1% rate.
2. Finance → Settings → Tax Profile → Registrations: a **Wake County Gross Receipts Account Number** required row appears under the Wake County authority.
3. Finance → Tax → new schedule: the party dropdown offers Wake County (monthly only); create a monthly schedule.
4. Open the generated task → **Recompute from Square**: the worksheet shows Gross Receipts, Applicable Gross Receipts, and Tax Owed (1%). Gross Receipts shows "—" until the optional general-sales-tax mapping is set.

- [ ] **Step 3: Record open (human-gated) items in the PR description**

- Apply migration `supabase/migrations/20260803_wake_county_food_beverage_tax.sql` to prod (after backup + explicit OK). Until applied, `getTaxRate` returns null and the worksheet uses the 1% statutory fallback with a warning; the Wake County registration cannot be saved (authority FK missing).
- In the app (post-migration): enter the Wake County Gross Receipts Account # (Tax Profile → Registrations) and the PIN + Square tax mappings (Tax Filing → Wake County), then create the monthly schedule.

- [ ] **Step 4: Final commit (if any QA-driven fixes were made)**

```bash
git add -A
git commit -m "test(tax): verify Wake County F&B module end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Gross Receipts (Sales & Use logic) → Task 4 (`general_sales_tax_id` base). ✅
- Applicable Gross Receipts (F&B-taxed items) → Task 4 (`food_beverage_tax_id` base). ✅
- Tax Owed at 1% → Task 4 (`round(applicable × rate)`), rate from `tax_rates` (Task 1) w/ fallback (Task 3). ✅
- Contact/Email/Phone reuse of Legal Representative → automatic via IdentityHeader (no task needed; noted in Task 7 QA). ✅
- Wake County Account # → Task 5 (`requiredRegistrations`) + Task 1 (authority). ✅
- 4-digit PIN masked → Task 5 (`filing_pin` sensitive settings field). ✅
- Monthly, due 20th → Task 5 (`defaultDueRule`/`computePeriod`). ✅
- Common components / UI standard → Task 6 (token utilities, `fmtCents`, shared shell). ✅
- Reuse DBs/routes; same org structure → shared extraction Task 2, plugin pattern throughout. ✅
- Migration + `prepared_food` category → Task 1. ✅

**Placeholder scan:** No TODOs/TBDs; every code step shows complete content. ✅

**Type consistency:** Field keys (`wake_gross_receipts_cents`, `wake_applicable_receipts_cents`, `wake_tax_owed_cents`, `wake_collected_fb_cents`, `wake_rate`) are identical across `computeWakeFigures` (Task 4), `resolveWakeFieldOwnership` (Task 3), `getTotalDueCents` (Task 6), and the Worksheet (Task 6). `fetchTaxableBase` signature matches between the shared module (Task 2) and its Wake caller (Task 4). Party/rate/authority/worksheet-component keys match the Global Constraints. ✅
