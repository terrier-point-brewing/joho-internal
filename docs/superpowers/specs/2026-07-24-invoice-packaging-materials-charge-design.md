# Auto-charge Packaging Materials on contract-brewing can invoices

**Date:** 2026-07-24
**Status:** Approved (design), pending implementation plan

## Goal

When generating a **contract-brewing** export invoice that includes **can** shipments,
automatically add a **Packaging Materials** line item per recipe, charging the partner
the cost of the packaging components consumed (cans, lids, labels, paktechs, trays).
The charge is a pure cost pass-through, computed live from each shipment's packaging
variation and the components' unit costs. No schema change.

## Motivation

Today the contract-brewing invoice auto-generates Packaging Fee (labor/handling),
Excise Tax, Keg Cleaning, and Forklift lines, but never bills the partner for the
physical packaging materials their beer was packaged into. A `packaging_material`
service-mapping type already exists in Export Settings but is orphaned — nothing in
`buildInvoicePreview` consumes it.

## Data model (already exists — verified)

```
export_transactions (recipe_id, packaging_item_id, packaging_format, quantity, units_per_package, channel)
  └─ recipe_packaging_variations (recipe_id → variation_id)
       └─ packaging_variations  [match container_id = packaging_item_id AND format = packaging_format]
            ├─ container_id → packaging_items.unit_cost           (qty: unitsPerPackage per package)
            ├─ lid_id       → packaging_items.unit_cost           (qty: unitsPerPackage per package)
            ├─ label_id     → packaging_items.unit_cost           (qty: unitsPerPackage per package)
            ├─ paktech_id   → packaging_items.unit_cost, can_count (qty: getPaktechUnitsPerPackage per package)
            └─ tray_id      → packaging_items.unit_cost           (qty: 1 per case, else 0)
```

- `packaging_items.unit_cost` is **USD dollars (decimal), nullable**.
- Format quantity math lives in `lib/production/packagingVariations.ts`
  (`getUnitsPerPackage`, `getPaktechUnitsPerPackage`) — reuse it, do not re-derive.
- `export_transactions` has **no** `variation_id`; the variation is resolved at query
  time by `(recipe_id ∩ container_id ∩ format)`, exactly as `buildProductLines` does
  (`exportInvoicePreview.ts:172-186`). Resolution must be exactly one row.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Pricing basis | Sum of component `unit_cost` (pure cost pass-through, **no markup**) |
| Granularity | **One line per recipe**, `"Packaging Materials — <Beer>"`, qty 1, unit price = total cents |
| Line description | Beer name only — **no** component breakdown |
| Missing `unit_cost` | Treat as **$0**, surface a preview **warning** listing the components |
| Scope | **Cans only** (`packaging_items.type !== 'keg'`); kegs skipped |
| Enablement | **Automatic** for every contract-brewing can invoice — no per-partner toggle. User can delete the line manually in the modal. |
| Square catalog mapping | **Optional.** The `packaging_material` mapping (if configured) supplies the line's `squareCatalogVariationId` for catalog/GL identity; if absent the line is ad-hoc with a null variation id (same pattern as the excise line). Price always comes from computed cost, never the catalog. |
| Schema | No migration |

## Component-quantity rules

For each can transaction, `packages = quantity` (in the packaging unit — cases for
`case` format, singles for `loose`), and per component:

| Component | Consumed qty per package |
|---|---|
| container (can) | `unitsPerPackage` |
| lid | `unitsPerPackage` (only if slot populated) |
| label | `unitsPerPackage` (only if slot populated) |
| paktech | `getPaktechUnitsPerPackage(format, tray.can_count, paktech.can_count)` (0 for `loose`) |
| tray | 1 for `case`, else 0 |

`consumed = packages × per-package-factor`, rounded to the nearest whole unit per
component. Only populated slots contribute. `cost = Σ consumed × dollarsToCents(unit_cost)`.

## Components

### `lib/production/packagingMaterials.ts` (new)

Pure cost math, unit-tested. No Supabase import.

```ts
export interface MaterialComponent {
  role: "container" | "lid" | "label" | "paktech" | "tray";
  name: string;
  unitCostDollars: number | null;   // packaging_items.unit_cost
  canCount: number | null;          // packaging_items.can_count (paktech/tray)
}

export interface MaterialTxnInput {
  format: string;                   // 'loose' | '4-pack' | '6-pack' | 'case'
  packages: number;                 // export_transactions.quantity
  unitsPerPackage: number;          // export_transactions.units_per_package
  components: MaterialComponent[];  // only populated slots
}

export function computeMaterialCost(txns: MaterialTxnInput[]): {
  totalCents: number;
  missingCostNames: string[];       // distinct component names with null unit_cost
};
```

### `lib/production/exportInvoicePreview.ts` (edit)

1. Add `warnings: string[]` to `InvoicePreviewResult`.
2. In the `contract_brewing` branch, after Packaging Fee lines, add a **Packaging
   Materials** step:
   - Skip keg-type transactions.
   - For each can transaction: resolve its variation (reuse the
     `recipe_packaging_variations` resolution), fetch the variation's populated slot
     items with `unit_cost`, `can_count`, `name`, build a `MaterialTxnInput`.
   - Group transactions by `recipe_id`; call `computeMaterialCost` per recipe.
   - Push one line per recipe with `totalCents > 0` (or `> 0` after rounding):
     `{ description: "Packaging Materials — <beer>", quantity: 1, unitPriceCents: totalCents,
        squareCatalogVariationId: <packaging_material mapping variation or null> }`.
   - Accumulate `missingCostNames` into `warnings`
     (`"No unit cost set for <names> — those components billed at $0. Set costs under Packaging Items."`).
3. Return `warnings` in the result. All non-contract-brewing branches return `warnings: []`.

Keep a thin server fetch (variation resolution + slot cost lookup) in this file or a
small internal helper; `computeMaterialCost` stays pure. Reuse `dollarsToCents`,
`getUnitsPerPackage`, `getPaktechUnitsPerPackage`.

### `app/production/components/InvoicePreviewModal.tsx` (edit)

Render `data.warnings` (when non-empty) as a `<Banner tone="accent">` above the line
items list. Each warning string on its own line. No behavioral change — the materials
line is an ordinary editable/removable line.

### `app/production/hooks/queries.ts` (edit if needed)

Ensure `useInvoicePreview`'s return type carries `warnings: string[]` (only if the hook
declares an explicit response type; otherwise inference covers it).

## Edge cases

- **Missing `unit_cost`** → component billed at $0, name added to `warnings`.
- **Recipe with $0 total** (all costs missing / no populated slots) → still emit the
  line at $0 with a warning? **No** — skip a recipe whose computed total is 0 to avoid
  a meaningless $0 line, but still surface the missing-cost warning so it's visible.
- **Variation resolution returns ≠ 1 row** → **do not throw.** The contract-brewing
  branch does not resolve variations today, so a hard throw here could block an
  otherwise-valid invoice over a materials line. Instead, skip the materials charge for
  that transaction and add a warning (`"Couldn't resolve packaging materials for <beer>
  (<container>, <format>) — no materials charged. Check Link Styles to Square."`).
  Consistent with the warn-don't-block choice for missing costs.
- **`billAs` override to contract_brewing** from another shipped channel → materials
  charge applies based on the effective (billed) channel, consistent with how the whole
  contract-brewing branch already keys on `channel`, not `shippedChannel`.
- **Partial cases** (fractional `quantity`) → per-component rounding as specified; minor
  cents drift is acceptable for a cost pass-through.

## Testing

- `packagingMaterials.test.ts` covers `computeMaterialCost`:
  - loose cans: container + lid + label only, no paktech/tray.
  - 6-pack: container/lid/label × unitsPerPackage + 1 paktech per package.
  - case: container/lid/label × 24, 6 paktechs/case (24/4), 1 tray/case.
  - null `unit_cost` → $0 + name in `missingCostNames`, no duplicate names.
  - empty components / zero packages → `totalCents: 0`.
  - cents conversion correctness (dollars → integer cents, rounding).
- Extend existing `exportInvoicePreview` tests (if present) or add coverage that the
  contract-brewing branch emits a materials line and populates `warnings`.
- `npm run verify` (lint + typecheck + tests) is the DoD.

## Out of scope

- Per-partner enable/disable toggle (may add later; deleting the line is the escape hatch).
- Markup / margin on materials.
- Materials charges for kegs or for distribution/wholesale channels.
- Backfilling materials charges onto already-generated invoices.
