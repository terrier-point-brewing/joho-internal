# Packaging Materials Charge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-add a per-recipe "Packaging Materials" line to contract-brewing can invoices, charging the partner the summed unit cost of the packaging components consumed.

**Architecture:** A pure `computeMaterialCost` (unit-tested, no DB) does the cost math; an async `buildPackagingMaterialLines` resolves each can transaction's packaging variation + component unit costs and produces the invoice lines + warnings; `buildInvoicePreview` calls it inside the `contract_brewing` branch and returns a new `warnings` field the modal renders.

**Tech Stack:** TypeScript, Next.js 16 route handler, Supabase (PostgREST embeds), Vitest, React Query, Tailwind v4.

**Execution Budget:** Mode = plan-and-execute-inline (per CLAUDE.md 4–6 file tier). No subagent spawns. Token target ~120k.

## Global Constraints

- Money: `packaging_items.unit_cost` is **USD dollars (decimal), nullable**; invoice `unitPriceCents` is **integer cents**. Cross the boundary only via `dollarsToCents(d: number)` from `@/lib/money`.
- No new raw-color utilities; warnings use existing `<Banner tone="accent">`.
- New/modified `lib/` logic ships with co-located `*.test.ts` (CLAUDE.md). Don't drop coverage below the vitest floor.
- DoD command: `npm run verify` (lint + typecheck + tests).
- No schema change / no migration in this plan.

---

### Task 1: Pure packaging-materials cost math

**Files:**
- Create: `lib/production/packagingMaterials.ts`
- Test: `lib/production/packagingMaterials.test.ts`

**Interfaces:**
- Consumes: `dollarsToCents` from `@/lib/money`.
- Produces:
  ```ts
  export type MaterialRole = "container" | "lid" | "label" | "paktech" | "tray";
  export interface MaterialComponent {
    role: MaterialRole;
    name: string;
    unitCostDollars: number | null;  // packaging_items.unit_cost
    canCount: number | null;         // packaging_items.can_count (paktech/tray)
  }
  export interface MaterialTxnInput {
    format: string;                  // 'loose' | '4-pack' | '6-pack' | 'case'
    packages: number;                // export_transactions.quantity
    unitsPerPackage: number;         // export_transactions.units_per_package
    components: MaterialComponent[]; // only populated slots
  }
  export function computeMaterialCost(txns: MaterialTxnInput[]): { totalCents: number; missingCostNames: string[] };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/production/packagingMaterials.test.ts
import { describe, it, expect } from "vitest";
import { computeMaterialCost, type MaterialTxnInput } from "./packagingMaterials";

// $0.15 can, $0.05 lid, $0.02 label, $0.30 paktech(4), $0.40 tray(24)
const can = { role: "container" as const, name: "12oz Can", unitCostDollars: 0.15, canCount: null };
const lid = { role: "lid" as const, name: "Lid", unitCostDollars: 0.05, canCount: null };
const label = { role: "label" as const, name: "Label", unitCostDollars: 0.02, canCount: null };
const paktech4 = { role: "paktech" as const, name: "PakTech 4", unitCostDollars: 0.30, canCount: 4 };
const tray24 = { role: "tray" as const, name: "Tray 24", unitCostDollars: 0.40, canCount: 24 };

describe("computeMaterialCost", () => {
  it("loose cans: only container+lid+label, no paktech/tray", () => {
    const txn: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid, label] };
    // 100 cans × (15+5+2) = 100 × 22 = 2200 cents
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 2200, missingCostNames: [] });
  });

  it("6-pack: container/lid/label × unitsPerPackage + 1 paktech per package", () => {
    const paktech6 = { role: "paktech" as const, name: "PakTech 6", unitCostDollars: 0.30, canCount: 6 };
    const txn: MaterialTxnInput = { format: "6-pack", packages: 10, unitsPerPackage: 6, components: [can, lid, label, paktech6] };
    // cans/lids/labels: 60 each → 60×15 + 60×5 + 60×2 = 900+300+120 = 1320
    // paktech: 10 packages × 1 = 10 × 30 = 300 ; total 1620
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 1620, missingCostNames: [] });
  });

  it("case: 24 cans/case, 6 paktechs/case (24/4), 1 tray/case", () => {
    const txn: MaterialTxnInput = { format: "case", packages: 2, unitsPerPackage: 24, components: [can, lid, label, paktech4, tray24] };
    // cans/lids/labels: 48 each → 48×15 + 48×5 + 48×2 = 720+240+96 = 1056
    // paktech: 2 × (24/4=6) = 12 → 12×30 = 360
    // tray: 2 × 1 = 2 → 2×40 = 80 ; total 1496
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 1496, missingCostNames: [] });
  });

  it("null unit_cost on a consumed component → billed $0 and named once (deduped)", () => {
    const noCostCan = { role: "container" as const, name: "12oz Can", unitCostDollars: null, canCount: null };
    const t1: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [noCostCan, lid] };
    const t2: MaterialTxnInput = { format: "loose", packages: 50, unitsPerPackage: 1, components: [noCostCan, lid] };
    // cans billed $0; lids: 150 × 5 = 750
    expect(computeMaterialCost([t1, t2])).toEqual({ totalCents: 750, missingCostNames: ["12oz Can"] });
  });

  it("does not warn about a null-cost component that is never consumed (qty 0)", () => {
    const noCostTray = { role: "tray" as const, name: "Tray 24", unitCostDollars: null, canCount: 24 };
    // loose format never consumes a tray, so a null-cost tray must not warn
    const txn: MaterialTxnInput = { format: "loose", packages: 10, unitsPerPackage: 1, components: [can, noCostTray] };
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 150, missingCostNames: [] });
  });

  it("empty input and zero packages → 0 cents, no warnings", () => {
    expect(computeMaterialCost([])).toEqual({ totalCents: 0, missingCostNames: [] });
    expect(computeMaterialCost([{ format: "loose", packages: 0, unitsPerPackage: 1, components: [can] }]))
      .toEqual({ totalCents: 0, missingCostNames: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/production/packagingMaterials.test.ts`
Expected: FAIL — `computeMaterialCost` is not defined / module not found.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/production/packagingMaterials.ts
//
// Pure cost math for the contract-brewing "Packaging Materials" invoice line.
// Given the packaging components consumed by a set of same-recipe can
// transactions, sum their unit costs into integer cents. No Supabase — the
// caller resolves each variation's slots and hands them in. The per-format
// component-quantity logic mirrors getUnitsPerPackage / getPaktechUnitsPerPackage
// in packagingVariations.ts, but operates on already-fetched can_counts so we
// never issue an extra query per transaction.
import { dollarsToCents } from "@/lib/money";

export type MaterialRole = "container" | "lid" | "label" | "paktech" | "tray";

export interface MaterialComponent {
  role: MaterialRole;
  name: string;
  unitCostDollars: number | null;
  canCount: number | null;
}

export interface MaterialTxnInput {
  format: string;
  packages: number;
  unitsPerPackage: number;
  components: MaterialComponent[];
}

// Paktech bundles consumed per package: 1 for a 4/6-pack, cansPerCase/cansPerPaktech
// for a case, 0 for loose (or if no paktech slot). Mirrors getPaktechUnitsPerPackage.
function paktechPerPackage(format: string, components: MaterialComponent[]): number {
  const paktech = components.find((c) => c.role === "paktech");
  if (!paktech) return 0;
  if (format === "4-pack" || format === "6-pack") return 1;
  if (format === "case") {
    const tray = components.find((c) => c.role === "tray");
    const pc = paktech.canCount ?? 0;
    if (!pc || !tray?.canCount) return 0;
    return tray.canCount / pc;
  }
  return 0;
}

// Whole units of one component consumed across a transaction (rounded).
function consumedQty(role: MaterialRole, txn: MaterialTxnInput): number {
  const { format, packages, unitsPerPackage } = txn;
  if (role === "container" || role === "lid" || role === "label") {
    return Math.round(packages * (unitsPerPackage || 1));
  }
  if (role === "paktech") return Math.round(packages * paktechPerPackage(format, txn.components));
  if (role === "tray") return Math.round(packages * (format === "case" ? 1 : 0));
  return 0;
}

export function computeMaterialCost(txns: MaterialTxnInput[]): { totalCents: number; missingCostNames: string[] } {
  let totalCents = 0;
  const missing = new Set<string>();
  for (const txn of txns) {
    for (const comp of txn.components) {
      const qty = consumedQty(comp.role, txn);
      if (qty <= 0) continue;
      if (comp.unitCostDollars == null) {
        missing.add(comp.name);
        continue; // billed $0
      }
      totalCents += qty * dollarsToCents(comp.unitCostDollars);
    }
  }
  return { totalCents, missingCostNames: [...missing] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/production/packagingMaterials.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/packagingMaterials.ts lib/production/packagingMaterials.test.ts
git commit -m "feat(invoice): pure packaging-materials cost math"
```

---

### Task 2: Resolve variations + build the material lines

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts` (add exported `buildPackagingMaterialLines` near `buildExciseTaxLines`, ~line 151)
- Test: `lib/production/exportInvoicePreview.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `computeMaterialCost`, `MaterialComponent`, `MaterialTxnInput` from `./packagingMaterials`; `InvoiceLineItemDraft`, `ExportTxRow` (already declared in this file); `crypto.randomUUID`.
- Produces:
  ```ts
  export async function buildPackagingMaterialLines(
    supabase: SupabaseClient,
    rows: ExportTxRow[],
    pkgTypeById: Map<string, string>,   // packaging_item_id → type ('can' | 'keg' | ...)
    pkgNameById: Map<string, string>,   // packaging_item_id → container display name (for warnings)
    recipeNameById: Map<string, string>,// recipe_id → beer name
    materialVariationId: string | null, // findMapping("packaging_material", null)?.square_catalog_variation_id ?? null
  ): Promise<{ lines: InvoiceLineItemDraft[]; warnings: string[] }>;
  ```

Behavior:
- Skip rows where `pkgTypeById.get(packaging_item_id) === "keg"` (cans only).
- Skip + warn rows with no `recipe_id`.
- Per remaining row, resolve its variation `(recipe_id ∩ container_id ∩ format)` and read populated slot items with `unit_cost` + `can_count`. On `≠ 1` match: skip + warn (do NOT throw).
- Group resolved rows by `recipe_id`; `computeMaterialCost` per group; push one line per group whose `totalCents > 0`.
- Aggregate distinct missing-cost names into a single warning; append per-row resolution warnings.

- [ ] **Step 1: Write the failing test**

```ts
// Append to lib/production/exportInvoicePreview.test.ts

import { buildPackagingMaterialLines } from "./exportInvoicePreview";

// Stub the recipe_packaging_variations resolve query. Each call chains
// .select(...).eq().eq().eq() → Promise<{ data }>. We return the variation whose
// (recipe, container, format) matches the eq() filters captured in order.
function pvStub(variationsByKey: Record<string, unknown[]>): SupabaseClient {
  const client = {
    from(_table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(col: string, val: unknown) { filters[col] = val; return chain; },
        then(resolve: (r: { data: unknown[]; error: null }) => void) {
          const key = `${filters["recipe_id"]}|${filters["packaging_variations.container_id"]}|${filters["packaging_variations.format"]}`;
          resolve({ data: variationsByKey[key] ?? [], error: null });
        },
      };
      return chain;
    },
  };
  return client as unknown as SupabaseClient;
}

// One case variation: 12oz can $0.15, lid $0.05, label $0.02, paktech(4) $0.30, tray(24) $0.40
const caseVariationRow = {
  packaging_variations: {
    container: { name: "12oz Can", unit_cost: 0.15, can_count: null, type: "can" },
    lid: { name: "Lid", unit_cost: 0.05 },
    label: { name: "Label", unit_cost: 0.02 },
    paktech: { name: "PakTech 4", unit_cost: 0.30, can_count: 4 },
    tray: { name: "Tray 24", unit_cost: 0.40, can_count: 24 },
  },
};

function matRows(rows: Array<Partial<{ id: string; recipe_id: string | null; packaging_item_id: string; packaging_format: string | null; quantity: number; units_per_package: number }>>) {
  return rows as unknown as Parameters<typeof buildPackagingMaterialLines>[1];
}

describe("buildPackagingMaterialLines", () => {
  const pkgType = new Map([["can-12", "can"], ["keg-half", "keg"]]);
  const pkgName = new Map([["can-12", "12oz Can"], ["keg-half", "1/2 BBL Keg"]]);
  const recipeName = new Map([["r1", "Fortnight"]]);

  it("emits one materials line per recipe at the summed cost, named by beer", async () => {
    const supabase = pvStub({ "r1|can-12|case": [caseVariationRow] });
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24 }]),
      pkgType, pkgName, recipeName, "var-mat",
    );
    // Same math as computeMaterialCost case test: 1496 cents.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ description: "Packaging Materials — Fortnight", quantity: 1, unitPriceCents: 1496, squareCatalogVariationId: "var-mat" });
    expect(warnings).toEqual([]);
  });

  it("skips keg-type transactions", async () => {
    const supabase = pvStub({});
    const { lines } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "keg-half", packaging_format: "loose", quantity: 6, units_per_package: 1 }]),
      pkgType, pkgName, recipeName, null,
    );
    expect(lines).toEqual([]);
  });

  it("warns and skips (no throw) when the variation can't be uniquely resolved", async () => {
    const supabase = pvStub({}); // no match → 0 rows
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "case", quantity: 2, units_per_package: 24 }]),
      pkgType, pkgName, recipeName, null,
    );
    expect(lines).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Couldn't resolve packaging materials for Fortnight/);
  });

  it("surfaces a missing-cost warning while still billing the priced components", async () => {
    const noCostCanVariation = {
      packaging_variations: {
        container: { name: "12oz Can", unit_cost: null, can_count: null, type: "can" },
        lid: { name: "Lid", unit_cost: 0.05 },
        label: null, paktech: null, tray: null,
      },
    };
    const supabase = pvStub({ "r1|can-12|loose": [noCostCanVariation] });
    const { lines, warnings } = await buildPackagingMaterialLines(
      supabase,
      matRows([{ id: "t1", recipe_id: "r1", packaging_item_id: "can-12", packaging_format: "loose", quantity: 100, units_per_package: 1 }]),
      pkgType, pkgName, recipeName, null,
    );
    // cans $0, lids 100 × 5 = 500
    expect(lines[0].unitPriceCents).toBe(500);
    expect(warnings.some((w) => w.includes("12oz Can") && w.includes("$0"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/production/exportInvoicePreview.test.ts`
Expected: FAIL — `buildPackagingMaterialLines` is not exported.

- [ ] **Step 3: Implement `buildPackagingMaterialLines`**

Add after `buildExciseTaxLines` (around line 151), and add the import at the top of the file:

```ts
import { computeMaterialCost, type MaterialComponent, type MaterialTxnInput } from "./packagingMaterials";
```

```ts
// Contract-brewing "Packaging Materials" lines: one per recipe, priced at the
// summed unit cost of the packaging components each can shipment consumed. Cans
// only (kegs are reusable / get keg-cleaning). Never throws — an unresolvable
// variation or missing unit cost degrades to a warning so it can't block an
// otherwise-valid invoice. Exported for unit testing.
const MATERIAL_SLOT_SELECT = `
  packaging_variations!inner(
    container:packaging_items!packaging_variations_container_id_fkey(name, unit_cost, can_count, type),
    lid:packaging_items!packaging_variations_lid_id_fkey(name, unit_cost),
    label:packaging_items!packaging_variations_label_id_fkey(name, unit_cost),
    paktech:packaging_items!packaging_variations_paktech_id_fkey(name, unit_cost, can_count),
    tray:packaging_items!packaging_variations_tray_id_fkey(name, unit_cost, can_count)
  )
`;

interface SlotItem { name: string; unit_cost: number | null; can_count?: number | null }

export async function buildPackagingMaterialLines(
  supabase: SupabaseClient,
  rows: ExportTxRow[],
  pkgTypeById: Map<string, string>,
  pkgNameById: Map<string, string>,
  recipeNameById: Map<string, string>,
  materialVariationId: string | null,
): Promise<{ lines: InvoiceLineItemDraft[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byRecipe = new Map<string, MaterialTxnInput[]>();

  for (const tx of rows) {
    if (pkgTypeById.get(tx.packaging_item_id) === "keg") continue; // cans only
    const containerName = pkgNameById.get(tx.packaging_item_id) ?? tx.packaging_item_id;
    const beerName = tx.recipe_id ? recipeNameById.get(tx.recipe_id) ?? null : null;
    const format = tx.packaging_format ?? "loose";

    if (!tx.recipe_id) {
      warnings.push(`Couldn't resolve packaging materials for "${containerName}" (${format}) — no recipe on the shipment, no materials charged.`);
      continue;
    }

    const { data: pvRows, error } = await supabase
      .from("recipe_packaging_variations")
      .select(MATERIAL_SLOT_SELECT)
      .eq("recipe_id", tx.recipe_id)
      .eq("packaging_variations.container_id", tx.packaging_item_id)
      .eq("packaging_variations.format", format);
    if (error || !pvRows || pvRows.length !== 1) {
      warnings.push(`Couldn't resolve packaging materials for ${beerName ?? containerName} (${containerName}, ${format}) — no materials charged. Check Link Styles to Square.`);
      continue;
    }

    const pv = (pvRows[0] as { packaging_variations: Record<string, SlotItem | null> }).packaging_variations;
    const roleBySlot: Array<[string, MaterialComponent["role"]]> = [
      ["container", "container"], ["lid", "lid"], ["label", "label"], ["paktech", "paktech"], ["tray", "tray"],
    ];
    const components: MaterialComponent[] = [];
    for (const [slot, role] of roleBySlot) {
      const item = pv[slot];
      if (!item) continue; // slot not populated on this variation
      components.push({ role, name: item.name, unitCostDollars: item.unit_cost, canCount: item.can_count ?? null });
    }

    const input: MaterialTxnInput = { format, packages: tx.quantity, unitsPerPackage: tx.units_per_package || 1, components };
    const list = byRecipe.get(tx.recipe_id) ?? [];
    list.push(input);
    byRecipe.set(tx.recipe_id, list);
  }

  const lines: InvoiceLineItemDraft[] = [];
  const missingAll = new Set<string>();
  for (const [recipeId, txns] of byRecipe) {
    const { totalCents, missingCostNames } = computeMaterialCost(txns);
    missingCostNames.forEach((n) => missingAll.add(n));
    if (totalCents <= 0) continue; // no meaningful $0 line
    const beerName = recipeNameById.get(recipeId) ?? null;
    lines.push({
      id: crypto.randomUUID(),
      description: beerName ? `Packaging Materials — ${beerName}` : "Packaging Materials",
      quantity: 1,
      unitPriceCents: totalCents,
      squareCatalogVariationId: materialVariationId,
    });
  }
  if (missingAll.size > 0) {
    warnings.push(`No unit cost set for ${[...missingAll].join(", ")} — those components billed at $0. Set costs under Packaging Items.`);
  }

  return { lines, warnings };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/production/exportInvoicePreview.test.ts`
Expected: PASS (existing suites + 4 new `buildPackagingMaterialLines` tests).

- [ ] **Step 5: Commit**

```bash
git add lib/production/exportInvoicePreview.ts lib/production/exportInvoicePreview.test.ts
git commit -m "feat(invoice): resolve variations and build packaging-materials lines"
```

---

### Task 3: Wire into buildInvoicePreview + surface `warnings`

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts` (`InvoicePreviewResult` interface ~line 18; `contract_brewing` branch ~line 294–400; return ~line 425)
- Modify: `app/production/hooks/queries.ts` (`useInvoicePreview` inline response type ~line 272–287)

**Interfaces:**
- Consumes: `buildPackagingMaterialLines` (Task 2); the existing `findMapping`, `recipeNameById`, `pkgTypeById`, `pkgNameById` locals already built in the branch.
- Produces: `InvoicePreviewResult` gains `warnings: string[]`.

- [ ] **Step 1: Add `warnings` to the result interface**

In `InvoicePreviewResult` (after `defaultDiscountCatalogId`):

```ts
  /**
   * Non-blocking advisories raised while building the preview (e.g. packaging
   * components with no unit cost, or a shipment whose packaging variation could
   * not be resolved for the materials charge). Rendered in the modal; never
   * blocks invoice generation. Empty for non-contract-brewing channels.
   */
  warnings: string[];
```

- [ ] **Step 2: Initialize and populate warnings in the builder**

Next to `const lineItems: InvoiceLineItemDraft[] = [];` (line 291) add:

```ts
  const warnings: string[] = [];
```

Inside the `contract_brewing` branch, after the Forklift block (line 400, before the closing `}` of the branch) add:

```ts
    // ── 5e. Packaging Materials — one line per recipe, cost of components used ──
    const materialVariationId = findMapping("packaging_material", null)?.square_catalog_variation_id ?? null;
    const materials = await buildPackagingMaterialLines(
      supabase, rows, pkgTypeById, pkgNameById, recipeNameById, materialVariationId,
    );
    lineItems.push(...materials.lines);
    warnings.push(...materials.warnings);
```

- [ ] **Step 3: Return `warnings`**

In the final `return { ... }` (line 425), add `warnings,` to the object.

- [ ] **Step 4: Extend the hook response type**

In `app/production/hooks/queries.ts`, `useInvoicePreview`, add `warnings: string[];` to the `fetchJson<{ ... }>` type literal (alongside `defaultDiscountCatalogId`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`recipeNameById` is in scope — it's declared at branch line 299, before the new 5e block.)

- [ ] **Step 6: Run the full production test suite**

Run: `npx vitest run lib/production/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/production/exportInvoicePreview.ts app/production/hooks/queries.ts
git commit -m "feat(invoice): add packaging-materials lines + warnings to contract-brewing preview"
```

---

### Task 4: Render warnings in the invoice modal

**Files:**
- Modify: `app/production/components/InvoicePreviewModal.tsx` (~after the bill-as override block, before the line-items list, ~line 297)

**Interfaces:**
- Consumes: `data.warnings` (string[]) from the preview query (Task 3). `Banner` is already imported.

- [ ] **Step 1: Render the warnings banner**

After the `isOverride && (…)` block and before the discount banner / line-items list, add:

```tsx
          {(data?.warnings?.length ?? 0) > 0 && (
            <Banner tone="accent">
              <ul className="list-disc pl-4 space-y-0.5">
                {data!.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}
```

- [ ] **Step 2: Verify in the browser**

Start the dev server (preview_start `{name}` from `.claude/launch.json`, or add one), open Production → Export Bay → select a contract-brewing can shipment in `invoice_required` status → Generate Invoice. Confirm:
- a `Packaging Materials — <Beer>` line appears with a non-zero unit price;
- if a component lacks a unit cost, an accent banner lists it;
- the line is editable/removable like any other.

If no suitable seeded data exists, rely on the Task 2 unit tests as the behavioral proof and note the manual check was not run.

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: lint + typecheck + tests all pass.

- [ ] **Step 4: Commit**

```bash
git add app/production/components/InvoicePreviewModal.tsx
git commit -m "feat(invoice): show packaging-materials warnings in the preview modal"
```

---

## Self-Review

- **Spec coverage:** cost pass-through (Task 1) ✓; one line per recipe named by beer (Task 2) ✓; cans-only (Task 2 keg skip) ✓; warn-and-zero on missing cost (Tasks 1+2) ✓; warn-and-skip on unresolvable variation (Task 2) ✓; automatic, no toggle (wired unconditionally in the contract-brewing branch, Task 3) ✓; optional `packaging_material` catalog identity, null-safe (Task 2/3) ✓; `warnings` surfaced in modal (Tasks 3+4) ✓; no schema change ✓.
- **Type consistency:** `MaterialComponent`/`MaterialTxnInput`/`computeMaterialCost` names identical across Tasks 1–2; `buildPackagingMaterialLines` signature identical in Task 2 def and Task 3 call; `warnings: string[]` consistent across interface, hook, and modal.
- **Placeholder scan:** none — every code step is complete.
- **Money seam:** dollars→cents only via `dollarsToCents`; `unitPriceCents` always integer.
