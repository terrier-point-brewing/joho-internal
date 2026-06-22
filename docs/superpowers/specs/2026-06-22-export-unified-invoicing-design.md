# Spec 6: Export > Export Transactions Unified Invoicing

## Context

Spec 6 was deferred mid-brainstorm because it depends on Customer × Service →
Square Item mapping plus configurable Barrel Excise Tax rates — neither
existed yet. Spec 7 (`docs/superpowers/specs/2026-06-21-export-settings-design.md`,
merged via [#23](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/23))
built exactly that: `export_service_mappings` (Packaging Fee / Keg Cleaning /
Forklift / Bulk Discount, with per-partner override + default-row fallback)
and `excise_tax_rates.square_catalog_item_id` /
`square_catalog_variation_id`. This spec is the invoice-generation logic that
*reads* those tables, explicitly out of scope for Spec 7.

`export_transactions` already has the status lifecycle this spec needs
(`invoice_required` → `unpaid` → `paid`, built in Spec 2a) and
`ExportTab.tsx` already renders that status badge under separate
Distribution / Contract Brewing subtabs. No new status is introduced by this
spec — the work is (a) a unified, customer-grouped view replacing those two
subtabs, and (b) the multi-select → combined Square invoice generation flow.

## Data Model

### 1. `export_transactions` (existing table, Spec 2a) — add one column

```sql
alter table public.export_transactions
  add column square_invoice_id text;
```

Set on every transaction included in a generated invoice (mirrors the
existing `brew_batches.square_invoice_id` pattern from the deposit-invoice
flow). Used to display "View Invoice" links and to prevent re-selecting an
already-invoiced transaction.

### 2. `contract_brewing_partners` (existing table) — add one column

```sql
alter table public.contract_brewing_partners
  add column export_net_terms_days integer;
```

Nullable per-customer override for export invoice payment terms. When null,
falls back to the global default (see below). Scoped to export invoices
only — the existing deposit-invoice flow computes its due date from
`batch.expected_delivery_date` / `planned_brew_date` and is **not** touched
by this spec.

### 3. `system_settings` (existing key/value table) — new key

```
key:   'export_invoice_due_days'
value: 30   (jsonb number)
```

Global default net terms (days) for export invoices, used when a partner's
`export_net_terms_days` is null. Editable in `ExportSettingsPanel`.

Due date for a generated export invoice = creation date +
(`contract_brewing_partners.export_net_terms_days` if set, else the
`export_invoice_due_days` system setting).

## UI / Navigation

### Unified Export Transactions view

Replaces the Distribution + Contract Brewing subtabs in `ExportTab.tsx` with
a single "Export Transactions" view:

- Transactions grouped by customer (`recipient_id` → `contract_brewing_partners`).
  Every non-taproom export transaction already has a `recipient_id` — the
  ship/ad-hoc-ship flows require selecting an existing partner from a
  `<select>`, never free text (`recipient_name` is taproom-only and out of
  scope here). Grouping is therefore strictly by `recipient_id`; there is no
  ungrouped/unlinked case to handle.
- Each customer group lists its `invoice_required` transactions with
  checkboxes. Selection is same-customer only — checkboxes for other
  customers' groups disable once a selection exists in a different group.
- If the selected customer's `contract_brewing_partners.square_customer_id`
  is null, the "Generate Invoice" button is disabled with an inline alert
  ("This partner has no linked Square customer — add one in Contract
  Brewing Partners before invoicing") rather than allowing the modal to open.
- Already-invoiced transactions (`status = 'unpaid'` or `'paid'`) display
  their status badge plus a "View Invoice" link (Square's hosted invoice
  `public_url`, fetched on demand) instead of a checkbox.

### Invoice preview modal

Opens on "Generate Invoice" with ≥1 same-customer transaction selected.
Shows the auto-computed line items below, each editable inline
(quantity/price), with an "Add line item" control and a per-row remove (×).
Confirming creates and publishes the Square invoice; canceling discards the
preview without writing anything.

## Line Item Generation

Computed server-side (`GET /api/production/export/invoice-preview`) from
the selected transaction IDs, then handed to the modal as a starting point
the user can edit before confirming:

1. **Packaging Fee** — one line per selected transaction. Quantity =
   `export_transactions.quantity`. Price = the Square catalog variation's
   own price, referenced via `export_service_mappings`
   (`service_type='packaging_fee'`, matched on `packaging_item_id`, looking
   up the partner-specific row first and falling back to the
   `partner_id is null` default row, per Spec 7's documented lookup
   convention).
2. **Excise Tax** — one line per distinct `receiving_party` across all
   `export_transaction_taxes` rows belonging to the selected transactions,
   summing `amount_usd`. Line description states the total taxed
   barrelage/gallons (in that tax's `unit`) across those transactions —
   this is a rollup across the whole invoice, not one line per transaction.
3. **Keg Cleaning** — one line. Quantity = count of selected transactions
   whose `packaging_items.type = 'keg'` and which have a Packaging Fee line
   (i.e. kegs actually being charged a packaging fee). Price from
   `export_service_mappings` (`service_type='keg_cleaning'`, no
   `packaging_item_id` dimension), partner-specific row first, default
   fallback.
4. **Forklift** — one flat line, quantity 1, regardless of how many
   transactions are selected. Price from `export_service_mappings`
   (`service_type='forklift'`), partner-specific row first, default
   fallback.
5. **Bulk Discount** — not a line item. A Square discount object
   (`export_service_mappings.square_catalog_discount_id`,
   `service_type='bulk_discount'`, partner-specific row first, default
   fallback) is attached directly to whichever line items are keg-type
   Packaging Fee lines (item #1, filtered to kegs).

If any required mapping is missing (e.g. no Keg Cleaning mapping exists for
this partner or the default), that line is simply omitted — the modal still
opens with whatever lines could be computed, and the user can add the
missing one manually via "Add line item" if needed.

## Square Integration

New module `lib/square/export-invoices.ts` — **not** a refactor of the
existing `lib/square/deposit-invoices.ts`, which is hardcoded to a single
line item and can't represent a multi-line order with per-line discounts.
The new module reuses `lib/square/client.ts`'s `squarePost`/`squareGet`
wrapper and any genuinely shared low-level helpers, but owns its own
create/publish/cancel/sync functions:

- `createExportInvoice(params)` — builds a Square order from the (possibly
  user-edited) line items + discounts, creates and publishes the invoice in
  one call. `dueDate` computed per the net-terms rule above.
- `getExportInvoiceStatus(invoiceId)` — mirrors
  `getDepositInvoiceStatus`'s shape (status, paidAt, version, publicUrl) for
  the "View Invoice" link and future status-sync needs.

On successful publish:
- All selected `export_transactions` rows get `square_invoice_id` set and
  `status` moved to `unpaid`.
- A server-side call fires to the existing
  `POST /api/finance/ledger/sync-square?year=<current year>` so the new
  invoice appears in Finance's ledger immediately rather than waiting for
  the next manual sync. This reuses that route's existing logic unchanged —
  no Finance-side schema or logic changes are part of this spec.

## API Routes

- `GET /api/production/export/invoice-preview?ids=<comma-separated export_transaction ids>`
  — validates same-customer, computes line items per the rules above, no
  Square calls. Returns 400 if the IDs span multiple customers or include
  anything not in `invoice_required` status.
- `POST /api/production/export/invoice` — body: transaction IDs + final
  line items/discounts (as edited in the modal). Creates and publishes the
  Square invoice via `createExportInvoice`, updates transaction
  `square_invoice_id`/`status`, triggers the Finance sync call.
- Role: `requireRole(["brewer"])` on both routes, consistent with the rest
  of Export Bay (`app/api/production/export-bay/**`).

## Explicit Non-Goals

- No changes to the deposit-invoice flow (`lib/square/deposit-invoices.ts`,
  `app/api/production/allocations/[id]/invoice/route.ts`) or its due-date
  logic.
- No changes to `export_service_mappings` or `excise_tax_rates` schema —
  Spec 7's shape is sufficient as-is.
- No Finance-side rework of the `invoices`/`invoice_line_items` ledger or
  its sync logic beyond calling the existing sync route after invoice
  creation.
- No handling of taproom ad-hoc exports (`recipient_name` free text) in the
  unified invoicing view — out of scope per this session's clarification.
- No partial-invoice or split-invoice support — one combined invoice per
  generation action, covering exactly the selected transactions.
