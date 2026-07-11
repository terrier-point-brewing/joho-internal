# Export-invoice line-item unification

**Date:** 2026-07-10
**Status:** Design approved — pending implementation plan
**Author:** will.liao@terrierpoint.com (+ Claude)
**Area:** `lib/finance`, `app/api/production/export`, `app/production/components`, `app/finance/transactions/invoices`, `supabase/migrations`

---

## 1. Problem

Export invoices render inconsistently in **Finance → Transactions → Invoices**, and some carry wrong money. Two independent write paths populate `invoice_line_items` differently, and the same row's shape (and values) changes over its lifecycle.

Concrete evidence (live prod data, read-only):

- **#000037** (contract brewing, open): 5 of 6 lines have `chart_of_accounts_id = null` despite every line carrying a valid `square_catalog_variation_id` whose variation already maps to a GL account. Descriptions are the app labels ("Packaging Fee", "Keg Cleaning"); `note` and `variation_name` are null.
- **#000031** (distribution, open): the Square order has a **30% "Contract Bulk Discount" = $948.00** (`LINE_ITEM` scope) on the Vienna Lager line. Our DB recorded **no discount** and the **gross** total ($3,311.39) instead of Square's authoritative **$2,363.39**.
- **#000001–#000023** (paid): all show `item — variation` descriptions, `variation_name` set, `raw_data` set, GL mapped — but `square_catalog_variation_id` null.

So the "two visual styles" are the **same invoices at two lifecycle stages**, and the columns swap depending on who wrote last.

### 1.1 Root cause

`invoice_line_items` stores line **identity** and line **money** in path-dependent columns:

| Field (conceptual) | Export `generate` writes | Square `sync` writes |
|---|---|---|
| catalog ref | `square_catalog_variation_id` | *(null)* — uses order's `catalog_object_id` transiently |
| variation name | *(null)* | `variation_name` |
| description | app label → `description` | `name — variation` → `description` (overwrites) |
| per-line note | *(null)* | *(null)* — Square line `note` ignored |
| discount | **not written** (discount only sent to Square) | `raw_data.discount` only (not `discount_cents`) |
| line total | **gross** (`qty × unit`) | net (`total_money`) |
| GL account | **not prefilled** | prefilled from variation |

Two consequences:

1. **Description drift + lossy convergence.** The Square sync overwrites `description` with the generic catalog name, collapsing distinct lines (both excise lines → identical `Barrel Excise Tax — Regular`; both keg-cleaning lines → identical `Keg Cleaning Service — With Labor`). The differentiating detail lives only in the app text, which the sync discards.
2. **Wrong money on un-synced invoices.** `generate` persists gross totals and never records the discount. Square holds the truth; our DB is wrong until a sync happens — and the post-`send` sync is fire-and-forget, swallows errors, refetches the whole year (hitting Square read-after-write lag on the just-created order), and is bypassed entirely when status flips via reconcile. So #031 never converged.

GL auto-map ([`app/api/finance/ledger/invoices/auto-map/route.ts`](../../../app/api/finance/ledger/invoices/auto-map/route.ts)) matches on **description text**, never on the `square_catalog_variation_id` sitting on the row — so Style-A export invoices can't auto-map even though the mapping data is present.

---

## 2. Goals / non-goals

**Goals**

1. Every export invoice line renders in one canonical 7-column shape regardless of write path or lifecycle: `catalog item + variation | description | qty | unit | discount | total | GL account`, plus invoice-level **discount** and **tax** summary rows.
2. Line identity (col 1) and free-text description (col 2) are distinct persisted fields, so repeated catalog items on one invoice stay delineated by their per-line note.
3. Line money (gross / discount / net / tax) is sourced from **Square's authoritative order**, never from the pre-discount draft.
4. GL auto-map keys off the catalog variation, not the description string.
5. `generate` and `sync` produce byte-identical rows by construction (shared mapping), eliminating drift.
6. Existing mis-recorded invoices are corrected by a one-time backfill.

**Also in scope (lower severity): deposit invoices** — see 3.10. They share the drift mechanism but not the money bug.

**Non-goals**

- Standard (POS) invoices — out of scope except where they share the mapping function (they must not regress).
- Changing what is sent *to* Square at invoice creation (line items + discounts are already correct in Square).
- Redesigning the export preview modal's UX beyond what's needed to show/persist the discount correctly.
- The deposit per-ingredient breakdown snapshot (separate table) — unaffected, left as-is.

---

## 3. Design

### 3.1 Canonical column model (`invoice_line_items`)

The table already carries most fields; the fix is to pick canonical columns and have **both** paths populate them.

| Display | Canonical column | Source (Square order line) |
|---|---|---|
| 1 — Catalog item + variation | `line_item_name` *(new)* + `variation_name` *(exists)* | `line.name`, `line.variation_name` |
| 2 — Description | `note` *(exists, unused)* | `line.note` |
| 3 — Qty | `quantity` | `line.quantity` |
| 4 — Unit price | `unit_price_cents` | `line.base_price_money` |
| 5 — Discount | `discount_cents` *(exists, unused in UI)* | `line.total_discount_money` |
| 6 — Total | `net_sales_cents` *(exists)* = gross − discount | `gross_sales_money − total_discount_money` |
| 7 — GL account | `chart_of_accounts_id` | prefilled from variation mapping |
| identity ref | `square_catalog_variation_id` *(exists)* | `line.catalog_object_id` |
| (also stored) | `gross_sales_cents`, `tax_cents` | `gross_sales_money`, `total_tax_money` |

- **col 1 render:** `line_item_name — variation_name`, falling back to `description` when there is no variation (manual / QuickBooks lines).
- **col 6 (Total):** `net_sales_cents` (gross − discount), **pre-tax**. Tax is shown only in the invoice-level tax row, keeping columns clean. For today's export invoices tax = 0, so line total = net.
- `description` is retained only as the **fallback label** for non-catalog lines; it is no longer overwritten by sync.
- Redundant catalog-ref columns `square_catalog_object_id` and `square_variation_id` are **backfilled into `square_catalog_variation_id` then dropped** (see 3.6). The duplicate `notes` (plural) column is unused by this feature; leave as-is (out of scope) unless the audit shows it safe to drop.

**Decision (confirmed): snapshot, not live-resolve.** `line_item_name` / `variation_name` are frozen at write time. Invoices are point-in-time records; this survives catalog renames/deletions and avoids a catalog join on every render. The sync/read-back paths already have the names in hand from the order.

### 3.2 Shared Square-order → line-item mapping

Extract the "one Square order line → one `invoice_line_items` row" logic (currently inline in `syncSquareInvoicesForYear`, [`lib/finance/syncSquareInvoices.ts`](../../../lib/finance/syncSquareInvoices.ts) lines ~203-249) into a pure, testable function:

```
lib/finance/invoiceLineItems.ts
  buildInvoiceLineItemRows(order, indexes): CanonicalLineItemRow[]
```

- `indexes` = the keg/can classification maps + `variationById` COA map already assembled by the sync.
- Emits every canonical column in 3.1, including `discount_cents`, `net_sales_cents`, `gross_sales_cents`, `line_item_name`, `note`, `square_catalog_variation_id`, and the GL prefill via existing `resolveLineItemCoa` (fill-nulls-only).
- Money semantics centralized here (see 3.1). Co-located `invoiceLineItems.test.ts` covers: discounted line, multi-line same-variation delineation, non-catalog line fallback, GL prefill non-destructiveness.

Both writers call this function:

- **`syncSquareInvoicesForYear`** replaces its inline block with `buildInvoiceLineItemRows`.
- **`generate` read-back** (3.3) calls it on the freshly-created order.

Result: identical rows by construction.

### 3.3 Generate read-back (anti-drift + correct money)

In the `generate` action ([`app/api/production/export/invoice/route.ts`](../../../app/api/production/export/invoice/route.ts)), after `createExportInvoice` returns:

1. **Fetch the created Square order back** (targeted, awaited — the order id is known, so no whole-year list, no read-after-write ambiguity).
2. Map it via `buildInvoiceLineItemRows` and upsert `invoice_line_items` (on `invoice_id, sort_order`), then delete stragglers past the new length (same pattern the sync uses).
3. Update the `invoices` header from the order's authoritative totals: `subtotal_cents` = Σ net_sales, `tax_cents` = order tax, `discount_cents` *(new, see 3.5)* = order-scoped discount, `total_cents` = `order.total_money`.

This single change fixes the discount, the totals, the description split, and the GL prefill at creation time — and removes reliance on the fragile post-`send` whole-year sync. The `send` action keeps a sync call as a **secondary** reconciliation (now idempotent via the shared mapping), but correctness no longer depends on it.

If the read-back fails (Square hiccup), fall back to persisting the modal-computed values (gross + estimated discount) and log — never leave the row unwritten. A later sync will reconcile.

### 3.4 GL auto-map keys off the variation

Rewrite [`app/api/finance/ledger/invoices/auto-map/route.ts`](../../../app/api/finance/ledger/invoices/auto-map/route.ts) source priority:

1. **Primary:** `square_catalog_variation_id → square_catalog_variations` (prefer `chart_of_accounts_id_invoice ?? chart_of_accounts_id`).
2. **Fallback:** existing description-string match (for manual / QuickBooks lines with no variation).

Fixes #037 (all 6 lines map). Keep the existing behavior of only filling `chart_of_accounts_id` where null.

### 3.5 Invoice-level discount + tax summary rows

- **Tax row:** from `invoices.tax_cents` (already present).
- **Invoice-level discount row:** add `invoices.discount_cents` *(new)*, populated from **order-scoped** (`scope = ORDER`) discounts only. Line-scoped discounts (like #031's bulk discount) stay in each line's `discount_cents` → col 5. Both today's channels apply their discount at `LINE_ITEM` scope, so the invoice-level row is typically empty but structurally present and future-proof.

### 3.6 Schema changes (one new migration)

New file `supabase/migrations/2026071X_invoice_line_item_unification.sql`:

1. `ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS line_item_name text;`
2. `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_cents bigint;`
3. Backfill `square_catalog_variation_id` from `square_variation_id` / `square_catalog_object_id` where null.
4. **Data backfill** of `line_item_name` / `variation_name` / `note` / money columns for existing rows — see 3.7 (done via re-sync, not raw SQL, to reuse the mapping).
5. After the re-sync backfill verifies clean, a **follow-up** migration drops `square_catalog_object_id` and `square_variation_id` (kept separate so the drop is reversible/staged; not in the first migration).

Follow project rule: new migration file, never edit existing ones. Apply to prod only per the migration-authorization process (explicit OK + backup), one at a time.

### 3.7 Backfill of existing invoices

Existing Style-A export invoices likely share #031's gross-total / missing-discount error, not just a display gap. Backfill = **re-run the Square sync** (now using the shared mapping) for affected invoices, which pulls authoritative money + populates canonical columns. Provide a one-shot admin route or script scoped to `invoice_type = export_invoice` (and optionally all invoices) for a year. Verify a sample against Square before/after.

### 3.8 Display (Finance → Transactions → Invoices)

[`app/finance/transactions/invoices/page.tsx`](../../../app/finance/transactions/invoices/page.tsx):

- Expand the line-item grid from 5 → 7 columns: `Line item | Description | Qty | Unit | Discount | Total | GL account`.
- col 1 = `line_item_name — variation_name` (fallback `description`); col 2 = `note`; col 5 = `discount_cents` (blank when 0).
- Add two summary rows beneath the lines: invoice discount (`invoices.discount_cents`) and tax (`invoices.tax_cents`), then the existing total.
- Extend the invoice fetch ([`app/api/finance/ledger/invoices/route.ts`](../../../app/api/finance/ledger/invoices/route.ts)) select to include `line_item_name`, `note`, `discount_cents`, `net_sales_cents`, `square_catalog_variation_id`, and `invoices.discount_cents`.

**Decision (confirmed): col 2 stays blank for generic lines.** When `note` is empty and the label is fully represented by col 1, show `—` rather than echoing col 1. Going forward, `generate`/read-back stores the Square line `note` (the meaningful differentiator, e.g. `TTB (1.50 bbls)`); generic service lines have no note and render `—`.

### 3.9 Export preview modal (minor)

[`app/production/components/InvoicePreviewModal.tsx`](../../../app/production/components/InvoicePreviewModal.tsx) already computes and displays `netTotalCents`. No functional change required for correctness (persistence is fixed server-side via read-back). Optionally surface the per-line discount in the modal's line rows for parity with the finance view — nice-to-have, not required.

### 3.10 Deposit invoices (`allocations/[id]/invoice`)

Deposit `generate` writes its finance line via `upsertFinanceLedgerInvoice` ([`app/api/production/allocations/[id]/invoice/route.ts`](../../../app/api/production/allocations/[id]/invoice/route.ts) lines ~457-505), which hardcodes `description: "Ingredient Deposit"` and omits `square_catalog_variation_id`, `variation_name`, `note`, and GL prefill — the same structural gap as export `generate`.

**Confirmed against live data (12 deposit invoices):**
- Same **cosmetic drift**: `Ingredient Deposit` (Style-A) → `Ingredient Deposit — Regular` (Style-B) on sync.
- **No money bug**: single line, qty 1, no discount, `unit_price_cents === total_cents` everywhere.
- **GL already maps** even pre-sync (`coa=Y`): every deposit line shares the identical `"Ingredient Deposit"` description, so description-based auto-map propagates reliably.
- Rich per-ingredient detail lives in a **separate breakdown snapshot table**, not in the line description — unaffected by sync overwrite.

So deposits carry the low-severity half of the problem (label drift, missing canonical columns) but not the high-severity half (wrong money, unmapped GL).

**Change:** route deposit `generate` through the same order read-back + `buildInvoiceLineItemRows` used by export (3.2/3.3), so the deposit line lands with `square_catalog_variation_id`, snapshot `line_item_name`/`variation_name`, GL prefill, and renders identically in the 7-column view. The deposit variation id is already in hand at generate (`mapping.square_catalog_variation_id`); the read-back also picks up Square's catalog names. `upsertFinanceLedgerInvoice`'s header write is retained; only the line-item write is replaced by the shared mapping.

**Priority:** lower than the export money fix — deposits are display-consistency only. Sequence after the export path lands (see 6). Backfill re-sync (3.7) can include `invoice_type = allocation_deposit` in the same pass.

---

## 4. Money semantics (single reference)

Per Square order line:

- `unit_price_cents` = `base_price_money.amount`
- `gross_sales_cents` = `gross_sales_money.amount` (= qty × unit)
- `discount_cents` = `total_discount_money.amount`
- `net_sales_cents` = `gross_sales_cents − discount_cents`  ← **col 6 Total**
- `tax_cents` = `total_tax_money.amount` (line; typically 0 here)

Invoice header:

- `subtotal_cents` = Σ `net_sales_cents`
- `discount_cents` *(new)* = Σ order-scoped discounts
- `tax_cents` = `order.total_tax_money`
- `total_cents` = `order.total_money`  (Square authoritative; = subtotal − order discount + tax)

Verification anchor (#031): net 221200 + 2332 + 12807 = **236339** = Square `total_money`. ✓

---

## 5. Testing

- `lib/finance/invoiceLineItems.test.ts` — mapping unit tests (discounted line, same-variation delineation, non-catalog fallback, GL prefill fill-nulls-only, money math).
- Update `syncSquareInvoices` tests to assert canonical columns (incl. `square_catalog_variation_id`, `note`, `discount_cents`).
- Auto-map route: variation-primary mapping, description fallback.
- Keep `lib/` coverage above the `vitest.config.ts` floor.
- Manual verification: regenerate a distribution invoice with a bulk discount; confirm finance tab shows discount in col 5, correct net total, and GL mapped on all lines; confirm re-sync is non-destructive.

---

## 6. Rollout order

1. Migration 1 (add `line_item_name`, `invoices.discount_cents`, backfill `square_catalog_variation_id`).
2. Shared mapping function + tests.
3. Wire sync → shared mapping; wire generate read-back.
4. Auto-map variation-primary.
5. Finance display 7-col + summary rows + fetch select.
6. Backfill re-sync of existing export invoices; verify sample vs Square.
7. Deposit `generate` → shared read-back/mapping (3.10); include deposits in a backfill re-sync pass.
8. Migration 2 (drop retired catalog-ref columns) once backfill verified.

Each migration applied to prod one at a time, explicit OK + backup, per project policy.

---

## 7. Risks / open items

- **Backfill blast radius:** re-syncing rewrites line rows for existing invoices; run first on a single invoice, diff against Square, then widen. Manual GL edits are preserved (fill-nulls-only), but description/money are authoritative-overwritten — acceptable and desired.
- **Non-export invoices share the mapping** (deposit, standard). The shared function must be verified not to regress those; their generate/sync paths are not switched to read-back in this spec (only export `generate` gets read-back).
- **`total_money` includes tax.** We deliberately store col-6 as pre-tax net and show tax separately; ensure header `total_cents` still equals Square `total_money` for reconciliation.
- **Order-scoped vs line-scoped discounts:** current channels use line scope; the invoice-level row is future-proofing. Confirm no channel emits order-scoped discounts today (none observed).
