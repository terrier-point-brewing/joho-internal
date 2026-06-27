# Three-Channel Invoicing Design

**Date:** 2026-06-27  
**Status:** Draft  
**Scope:** Add `wholesale` as a third commitment/export channel; rework export invoicing to produce channel-appropriate line items for Contract Brewing, Distribution, and Wholesale; extend `recipe_square_links` to support per-format can mappings.

---

## 1. Problem

The system currently treats all non-taproom exports as a single invoicing model (packaging fees + excise tax). In reality there are three distinct sales channels with different invoicing rules:

| Channel | Deposit Invoice | Export Invoice Lines | Excise Tax | Discount |
|---|---|---|---|---|
| Contract Brewing | Yes — ingredient deposit | Packaging fees (service charges) | Yes | bulk_discount |
| Distribution | No | Actual inventory items (Square products) | Yes | distribution_discount |
| Wholesale | No | Actual inventory items (Square products) | No | wholesale_discount |

Additionally, `wholesale` does not exist as a channel anywhere in the system today. Commitments only recognise `contract_brewing` and `distribution`.

---

## 2. Goals

1. Add `wholesale` channel throughout (DB constraints, TypeScript types, UI).
2. Rework `recipe_square_links` to capture per-format can mappings, making it the source of truth for "which Square product variation represents this beer in this packaging."
3. Branch export invoice line item building by channel so each channel produces the correct invoice automatically.
4. Gate deposit invoice controls correctly (contract_brewing only — already partially true, just needs wholesale exclusion confirmed).
5. Add `distribution_discount` and `wholesale_discount` as configurable discount types in Export Settings.

---

## 3. Non-Goals

- No changes to the deposit invoice flow for contract_brewing.
- No changes to taproom, safety_stock, or draft allocations.
- No Square inventory depletion (Square inventory tracking is read-only from this app's perspective).
- No rework of the excise tax rate table or how `export_transaction_taxes` rows are created.
- No rework of the finance ledger sync or QuickBooks path.

---

## 4. Channel Model Changes

### 4.1 Database

One migration touches four constraints:

**`commitments.channel`** CHECK:
```
('distribution', 'contract_brewing') → ('distribution', 'contract_brewing', 'wholesale')
```

**`batch_allocations.channel`** CHECK:
```
('taproom','distribution','contract_brewing','safety_stock')
→ ('taproom','distribution','contract_brewing','wholesale','safety_stock')
```

**`export_transactions.channel`** (currently `export_channel` enum or CHECK — whichever the baseline uses):
```
add 'wholesale'
```

**`invoice_item_mappings.service_type`** CHECK — add two new discount types:
```
add 'distribution_discount', 'wholesale_discount'
```
These follow the exact shape of `bulk_discount`: only `square_catalog_discount_id` is populated; `packaging_item_id`, `packaging_format`, and `square_catalog_variation_id` are all NULL.

### 4.2 TypeScript

`app/production/types.ts` — `CommitmentChannel` union:
```ts
// before
type CommitmentChannel = "distribution" | "contract_brewing";
// after
type CommitmentChannel = "distribution" | "contract_brewing" | "wholesale";
```

`ExportChannel` (also in types.ts):
```ts
// before
type ExportChannel = "taproom" | "distribution" | "contract_brewing";
// after
type ExportChannel = "taproom" | "distribution" | "contract_brewing" | "wholesale";
```

Any `CHANNEL_META` or label/color maps in the UI that enumerate channels must add a `wholesale` entry.

---

## 5. `recipe_square_links` Rework

### 5.1 Why

`recipe_square_links` currently maps `(recipe_id, packaging_item_id)` → `square_variation_id`. This works for kegs (each keg size is its own `packaging_item`) but not for cans: a single 12oz can `packaging_item` can correspond to multiple Square variations depending on pack format (single, 4-pack, 6-pack, case). The format dimension is missing.

### 5.2 Schema change

Add column to `recipe_square_links`:
```sql
ALTER TABLE recipe_square_links ADD COLUMN packaging_format text
  CHECK (packaging_format IN ('loose','4-pack','6-pack','case'));
```

Drop the existing partial unique constraint on `(recipe_id, packaging_item_id) WHERE packaging_item_id IS NOT NULL` and replace with two partial unique indexes:

```sql
-- Kegs: format is NULL, uniqueness is recipe + container
CREATE UNIQUE INDEX rsl_keg_uniq
  ON recipe_square_links (recipe_id, packaging_item_id)
  WHERE packaging_item_id IS NOT NULL AND packaging_format IS NULL;

-- Cans: uniqueness is recipe + container + format
CREATE UNIQUE INDEX rsl_can_format_uniq
  ON recipe_square_links (recipe_id, packaging_item_id, packaging_format)
  WHERE packaging_item_id IS NOT NULL AND packaging_format IS NOT NULL;
```

The existing draft partial unique index (`WHERE packaging_item_id IS NULL`) is unchanged.

Existing rows (all have `packaging_format = NULL`) are valid — they represent keg-type links and fall under the keg index. No data migration required.

### 5.3 Lookup key summary

| Packaging type | Lookup key |
|---|---|
| Keg (any size) | `(recipe_id, packaging_item_id, packaging_format=NULL)` |
| Can — loose | `(recipe_id, packaging_item_id, packaging_format='loose')` |
| Can — 4-pack | `(recipe_id, packaging_item_id, packaging_format='4-pack')` |
| Can — 6-pack | `(recipe_id, packaging_item_id, packaging_format='6-pack')` |
| Can — case | `(recipe_id, packaging_item_id, packaging_format='case')` |

### 5.4 API changes (`/api/production/recipe-square-links`)

**POST**: accept optional `packaging_format` in body. Validate that cans (packaging_item.type = 'can') require a format; kegs must not provide one.

**GET**: return `packaging_format` in each row. No other changes.

### 5.5 `SquareLinkManager` UI changes

When the selected packaging item is type `can`, show a **Format** dropdown alongside the Square variation selector:
- Options: `Loose (single)`, `4-Pack`, `6-Pack`, `Case`
- Required for cans; hidden for kegs and draft.

The quick-add flow (expand all packaging types for a recipe) should expand one row per can format that makes sense for that container. Keep it simple: expand `4-pack` and `case` by default for cans (the most common), and allow manual addition of `loose` / `6-pack` rows as needed. Kegs expand one row per keg-size packaging item as before.

---

## 6. Export Invoice Line Item Branching

### 6.1 Current state

`buildInvoicePreview()` in `lib/production/exportInvoicePreview.ts` is channel-blind. It always produces:
1. Packaging fee lines (from `invoice_item_mappings`, `service_type='packaging_fee'`)
2. Excise tax lines (from `export_transaction_taxes`)
3. Keg cleaning line
4. Forklift line
5. `bulk_discount` applied to keg packaging fee lines

### 6.2 New behaviour

After loading transactions, read `channel` from the rows. Validate that all transactions in the preview share the same channel (throw if mixed — this should never occur in practice but is worth guarding).

Branch on channel:

#### `contract_brewing` (unchanged)
Steps 5a–5d exactly as today. No code change to the logic, only ensure the channel guard routes correctly.

#### `distribution`
1. **Product lines** — for each transaction, look up `recipe_square_links` by `(recipe_id, packaging_item_id, packaging_format)` to get `square_variation_id`. Use `buildStandalonePriceMap` to get the price. One line per transaction. Throw a clear error if no link is configured ("Link this recipe's packaging to a Square item in Production → Link Styles to Square before generating a Distribution invoice").
2. **Excise tax** — same logic as contract_brewing (5b). Read from `export_transaction_taxes`.
3. **`distribution_discount`** — look up `invoice_item_mappings` where `service_type='distribution_discount'`, preferring partner-specific row over default. Apply as `discountCatalogId` on all **product** line items only (same mechanism as `bulk_discount`). Excise tax lines are never discounted. Optional — if no mapping configured, no discount applied.
4. No packaging fee lines, no keg cleaning, no forklift.

#### `wholesale`
1. **Product lines** — same recipe_square_links lookup as distribution.
2. **No excise tax** — skip step entirely, even if `export_transaction_taxes` rows exist.
3. **`wholesale_discount`** — same lookup pattern as distribution_discount. Applied to product lines only, not excise tax lines (moot since wholesale has no excise tax, but consistent with the rule). Optional.
4. No packaging fee lines, no keg cleaning, no forklift.

### 6.3 `buildInvoicePreview` signature

No signature change. The function already loads `channel` from the `export_transactions` rows it fetches — the branching is internal.

---

## 7. Deposit Invoice Gating

The deposit invoice UI is currently gated in `CommitmentsTab` with:
```tsx
if (commitment.channel !== "contract_brewing") {
  return <span>— (Distribution does not use deposit invoices)</span>;
}
```

Update the label to cover all non-contract_brewing channels:
```tsx
if (commitment.channel !== "contract_brewing") {
  return <span>— (Deposit invoices are only used for Contract Brewing)</span>;
}
```

No changes to the invoice generation API, allocation locking, or payment sync — these only trigger for `contract_brewing` allocations and that remains correct.

---

## 8. Export Settings Panel — New Discount Types

Add `distribution_discount` and `wholesale_discount` as selectable service types in the invoice item mappings section of `ExportSettingsPanel`.

Behaviour mirrors the existing `bulk_discount` type:
- Only `square_catalog_discount_id` is relevant (no packaging item, no variation).
- Can be set as a default (partner_id = null) or per-partner override.
- UI renders the Square Discount selector (already exists via `SquareDiscountSelect`).

No other changes to Export Settings.

---

## 9. UI: Commitments Tab

In the new/edit commitment form:

- **Channel** dropdown adds `Wholesale` as a third option.
- `CHANNEL_META` map adds entry: `wholesale: { label: "Wholesale", cls: "bg-teal-900/40 text-teal-300" }` (or similar).
- Scheduling UI: wholesale commitments follow the same recurring/one-time rules as distribution (no special treatment needed).
- Default channel remains `contract_brewing`.

---

## 10. UI: Export Bay Tab

In the ad-hoc export modal:
- Channel select adds `<option value="wholesale">Wholesale</option>`.

Allocation-based shipping:
- Wholesale allocations are already included (the ship route only excludes `taproom`). No change to the grouping or ship button logic.
- The ship route (`/api/production/export-bay/ship`) validates that `channel` is a known non-taproom value — add `wholesale` to the accepted set.

The active-allocation check before ad-hoc exports already works by recipe + partner; wholesale allocations will be caught correctly.

---

## 11. Allocations API

`POST /api/production/allocations` — add `'wholesale'` to the valid channel enumeration check.

`GET /api/production/allocations` — enrichment (produced_bbl, exported_bbl, fulfilled) is channel-agnostic; no change needed.

---

## 12. Ship Route

`/api/production/export-bay/ship/route.ts`:
- The route reads `channel` from the matched `batch_allocations` row and passes it through to `writeExportTransaction`. Wholesale flows through automatically.
- The allocation query already excludes `taproom`. Wholesale allocations are therefore naturally included in candidate selection.
- `checkAndFulfillCommitment` in `commitmentFulfillment.ts` queries exported volume without channel restriction per allocation — wholesale fulfillment check works without changes.

---

## 13. Data Flow Summary

```
Commitment (channel: contract_brewing | distribution | wholesale)
  └─ batch_allocation (same channel)
       └─ export_transaction (same channel, written by ship route)
            └─ buildInvoicePreview() reads channel from export_transactions
                 ├─ contract_brewing → packaging fees + excise + cleaning + forklift + bulk_discount
                 ├─ distribution    → product items (recipe_square_links) + excise + distribution_discount
                 └─ wholesale       → product items (recipe_square_links) + wholesale_discount
```

---

## 14. Migration Plan

Single migration `20260627_three_channel_invoicing.sql`:

1. Alter `commitments.channel` CHECK to add `'wholesale'`.
2. Alter `batch_allocations.channel` CHECK to add `'wholesale'`.
3. Alter `export_transactions.channel` CHECK (or enum) to add `'wholesale'`.
4. Alter `invoice_item_mappings.service_type` CHECK to add `'distribution_discount'`, `'wholesale_discount'`.
5. Add `packaging_format` column to `recipe_square_links`.
6. Drop old can-link unique constraint/index on `recipe_square_links`.
7. Create two new partial unique indexes on `recipe_square_links`.

No data migrations required. All existing rows remain valid.

---

## 15. Open Questions / Decisions Already Made

| Question | Decision |
|---|---|
| Should wholesale ever have excise tax? | No — wholesale explicitly excludes it. |
| Mixed-channel transaction sets in one invoice? | Blocked with a clear error. Should never occur in practice. |
| Quick-add default formats for cans in SquareLinkManager? | 4-pack + case by default; loose/6-pack added manually. |
| Keg cleaning / forklift for distribution/wholesale? | Not included — these are contract brewing service charges only. |
| What if recipe_square_links entry is missing for a distribution/wholesale export? | Throw a descriptive error pointing to "Link Styles to Square". |
| Should distribution_discount / wholesale_discount be required? | No — optional. If no mapping configured, invoice generates without a discount. |
