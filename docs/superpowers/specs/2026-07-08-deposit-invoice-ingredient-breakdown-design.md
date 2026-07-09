# Deposit Invoice — Frozen Ingredient Breakdown

**Date:** 2026-07-08
**Status:** Design approved, pending spec review

## Problem

The "ingredient deposit" amount on a contract-brewing deposit invoice is computed
from each recipe ingredient's `quantity_per_bbl` and the ingredient's live
`cost_per_unit`, times batch volume and the allocation percentage. See
`calculateIngredientDeposit()` in `lib/square/square-invoices.ts:88`.

That per-ingredient breakdown is computed **live and discarded** — only the total
`deposit_cents` is persisted (onto `batch_allocations` and as a single
"Ingredient Deposit" line in the finance ledger). The inputs are **un-versioned**:
`ingredients.cost_per_unit` and `recipe_ingredients.quantity_per_bbl` are plain
columns overwritten in place.

Consequence: once an ingredient price changes, recomputing today no longer
reproduces the breakdown that actually fed a past deposit. The frozen composition
is unrecoverable from the schema alone.

We also lack an independent view to review deposit invoices. They are only visible
embedded in Brewing > Batch Log and Intake > Commitments.

## Goals

1. Persist the frozen per-ingredient breakdown at the moment a deposit invoice is
   generated, so it can always be referenced later regardless of later price
   changes.
2. Backfill existing deposit invoices, reconstructing the frozen prices/quantities
   from the point in time each invoice was generated.
3. Add an independent Brewing subtab to review deposit invoices, mirroring how
   Export Invoices are shown under the Export tab.

## Key facts established during investigation

- **Deposit calculation:** `calculateIngredientDeposit()` (`lib/square/square-invoices.ts:88`)
  returns a `DepositCalculation` whose `breakdown[]` already contains
  `{ name, quantity_per_bbl, cost_per_unit, unit, line_total_usd }` per ingredient.
  `line_total_usd = quantity_per_bbl × cost_per_unit × volume_bbl` (full-batch cost,
  before the allocation percentage). `deposit_usd = sum(line_total_usd) × pct/100`.
- **Deposit invoice record:** the finance ledger `invoices` row with
  `invoice_type = 'allocation_deposit'` (see
  `supabase/migrations/20260612_allocation_deposit_invoices.sql`). It carries
  `allocation_id`, `partner_id`, `customer_name`, `status`, `invoice_number`,
  `total_cents`, `square_invoice_id`. This row **survives revisions** (upserted on
  `source, external_id = square_invoice_id`) and is the authoritative deposit-invoice
  entity — the correct owner of the breakdown.
- **Audit history exists:** `audit_log` (`supabase/migrations/20260609_baseline.sql:238`)
  captures full `old_data`/`new_data` JSON with `changed_at` on every change to
  `ingredients` and `recipe_ingredients` (triggers at lines 605, 635). This is the
  source for reconstructing historical prices/quantities during backfill.
- **UI template:** Export Invoices (`app/production/components/ExportInvoicesTab.tsx`,
  route `app/api/production/export/invoices/route.ts`) is an expandable table driven
  off `invoices` filtered by `invoice_type`, with filter bar + summary strip +
  per-row expanded panel. The deposit view mirrors this.

## Design decisions

1. **Attach the breakdown to the deposit invoice** (the `invoices` ledger row), not
   to `batch_allocations`. Conceptually correct and lets the new subtab drive off
   `invoices` exactly like Export Invoices.
2. **One new table only.** No header table, no snapshot columns on `batch_allocations`.
   Header-ish facts (batch volume, allocation %) are read live from the
   allocation/batch; totals are already on the ledger `invoices.total_cents`.
3. **Line totals are stored pre-scaled to tie to the invoice total** (reconcile-to-total).
   Each stored `line_total_cents` is that ingredient's share of the actual invoiced
   deposit, so the column sums exactly to the deposit. No reconciliation/provenance
   columns are stored; all rows are treated uniformly whether live or backfilled.
4. **Replace-on-regenerate.** The breakdown is immutable *current* provenance, not a
   version log. Regenerating a deposit replaces its breakdown lines.

## Schema

New migration `supabase/migrations/<date>_deposit_invoice_ingredients.sql`:

```sql
create table public.deposit_invoice_ingredients (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references public.invoices(id) on delete cascade,
  ingredient_id    uuid references public.ingredients(id) on delete set null,
  ingredient_name  text    not null,
  unit             text    not null,
  quantity_per_bbl numeric not null,
  cost_per_unit    numeric not null,
  line_total_cents integer not null,   -- this ingredient's share of the deposit; SUM = invoice total_cents
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

create index deposit_invoice_ingredients_invoice_id_idx
  on public.deposit_invoice_ingredients(invoice_id);
```

Add the standard `audit_deposit_invoice_ingredients` trigger (mirroring the existing
`audit_*` trigger definitions in the baseline migration).

`line_total_cents` semantics: the per-ingredient **deposit share**, i.e.
`round(line_total_usd × pct/100 × reconcile_factor)` in cents, where
`reconcile_factor` guarantees `sum(line_total_cents) = invoices.total_cents`. The
frozen `quantity_per_bbl` and `cost_per_unit` are stored for provenance/display;
they are not required to arithmetically equal `line_total_cents` (batch volume and
allocation % are applied on top).

## Write path (new invoices, going forward)

New module `lib/production/depositBreakdown.ts`:

- `snapshotDepositBreakdown(adminSupabase, invoiceId, calc, invoiceTotalCents)`:
  deletes any existing lines for `invoiceId`, converts each `calc.breakdown[]` entry
  to a line, scales `line_total_cents` so the sum equals `invoiceTotalCents`
  (largest-remainder rounding so integer cents sum exactly), inserts the lines.
- Pure helper `buildBreakdownLines(breakdown, invoiceTotalCents)` extracted for unit
  testing (no DB).

Call sites in `app/api/production/allocations/[id]/invoice/route.ts`:

- `generate` action: after `upsertFinanceLedgerInvoice(...)` returns `ledgerInvoiceId`,
  call `snapshotDepositBreakdown(adminSupabase, ledgerInvoiceId, calculation, calculation.deposit_cents)`.
- `mark_paid` (external QB/other) action: after the `invoices` upsert returns `inv.id`,
  compute the breakdown (`calculateIngredientDeposit`) if not already available and
  snapshot it against `amountCents`. (These rows have no live Square calc at
  mark-paid time; compute from current recipe data — acceptable since external
  backfill is inherently after-the-fact and the amount is the source of truth.)

## Backfill (reviewable script; prod write gated on explicit approval + backup)

New module `lib/production/depositReconstruction.ts` (pure logic, unit-tested):

- `reconstructIngredientStateAsOf(auditRows, ingredientId, asOf)` → the
  `cost_per_unit` in effect at `asOf`: latest `audit_log.new_data.cost_per_unit`
  with `changed_at ≤ asOf`; if no change on/before `asOf`, fall back to the earliest
  known `old_data` (the pre-first-change value) or the current live value if the row
  was never audited.
- `reconstructRecipeIngredientQtyAsOf(...)` → same for
  `recipe_ingredients.quantity_per_bbl`.
- `reconstructDepositBreakdown(...)` → assembles the frozen `breakdown[]` for an
  allocation as of its as-of timestamp.

Backfill script `scripts/backfill-deposit-breakdowns.ts` (dry-run first):

1. Select every deposit `invoices` row (`invoice_type = 'allocation_deposit'`) joined
   to its `batch_allocations` → `brew_batches` → `recipe_ingredients` → `ingredients`.
2. As-of timestamp for each: `invoice_generated_at ?? invoice_sent_at ?? invoice_paid_at ?? invoice_date`.
3. Load relevant `audit_log` rows for the recipe's ingredients and recipe_ingredients.
4. Reconstruct the frozen breakdown; scale line shares to the stored `total_cents`
   (same `buildBreakdownLines` helper as the write path).
5. Dry-run mode: report each invoice's reconstructed-vs-stored total delta for review.
   Apply mode: write the lines.

Per the standing rule (`feedback_prod_db_migration_authorization`), the schema
migration and the backfill apply run against prod only after explicit user OK and a
backup. The script defaults to dry-run.

## Read path

New route `app/api/production/deposit-invoices/route.ts` (GET, `requireRole(["brewer"])`):

- Select `invoices` where `invoice_type = 'allocation_deposit'`, joined to
  `deposit_invoice_ingredients` (breakdown lines), and `batch_allocations` →
  `brew_batches` (beer name, batch number, volume) plus `percentage` for context.
- Enrich with the Square dashboard URL (same pattern as
  `export/invoices/route.ts`).
- Return a typed list mirroring the export-invoice list shape, with an added
  `breakdown` array per invoice.

Add `queryKeys.production.depositInvoices()` in `lib/query-keys.ts`.

## UI

- `app/production/nav-config.ts`: add `BREWING_NAV` entry
  `{ href: "/production/brewing/deposit-invoices", label: "Deposit Invoices" }`.
- `app/production/brewing/deposit-invoices/page.tsx`: renders `<DepositInvoicesTab />`.
- `app/production/components/DepositInvoicesTab.tsx`: mirrors `ExportInvoicesTab` —
  filter bar (partner / status / year), summary strip (count, open $, total $),
  expandable rows. The expanded panel shows:
  - Deposit metadata: partner, batch (`#num beer_name`), allocation %, batch volume,
    generated/sent/paid dates, status badge, "View in Square" link.
  - **Frozen ingredient breakdown table**: ingredient · unit · quantity_per_bbl ·
    cost_per_unit · line total, with the line-total column summing to the deposit.
- Follow `docs/UI_STANDARD.md`: reuse token utilities, `<Badge>`, existing table/
  filter patterns from `ExportInvoicesTab`; no raw colors, no hand-rolled primitives.

## Tests

- `lib/production/depositBreakdown.test.ts`: `buildBreakdownLines` — share scaling,
  integer-cent reconciliation (sum equals total exactly under largest-remainder
  rounding), zero/empty cases.
- `lib/production/depositReconstruction.test.ts`: point-in-time `audit_log` replay —
  price change before/after as-of, never-audited fallback, ingredient added after the
  invoice date, multiple changes.

Keep `lib/` coverage above the `vitest.config.ts` threshold.

## Out of scope (YAGNI)

- Editing frozen breakdowns from the UI (immutable provenance).
- On-demand re-reconstruction from the UI.
- A per-regeneration version history (breakdown is replaced, not versioned).
- Any backfill-provenance flag/column (`is_estimated`, reconciliation factor, etc.).
