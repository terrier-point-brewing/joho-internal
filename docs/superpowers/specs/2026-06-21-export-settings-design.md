# Spec 7: Export Settings + Barrel Excise Tax Settings

## Context

This spec was originally numbered after Spec 6 ("Export > Commitments unified
invoicing") in `docs/superpowers/ROADMAP.md`, but brainstorming Spec 6
revealed it depends on configuration that doesn't exist yet: a way to map
each export-related fee/tax/discount to the correct Square catalog object,
per customer where relevant. That configuration is this spec. Spec 6 is
deferred until this spec is merged.

Out of scope for this spec: any invoice-generation logic that *reads* the
tables/settings defined here. That's Spec 6's job, in a future session.

## Data Model

### 1. `excise_tax_rates` (existing table, Spec 2a) — add two columns

```sql
alter table public.excise_tax_rates
  add column square_catalog_item_id text,
  add column square_catalog_variation_id text;
```

Each excise tax rate (e.g. "Federal Excise Tax" / TTB / bbl / $3.50, "NC
Excise Tax" / NC Department of Revenue / gallon / $0.62) gets its own Square
Line Item mapping. It's expected the same Square catalog item/variation may
be reused across multiple excise tax rate rows (e.g. one generic "Excise Tax"
Square item used for both Federal and NC rows, distinguished by the line
item's description/amount, not by having separate Square items per
jurisdiction) — there is no uniqueness constraint forcing distinct Square
items per row.

This table currently has no CRUD UI at all (only seeded via migration). This
spec adds full create/edit/deactivate UI for it.

### 2. New table `export_service_mappings`

Customer × Service → Square Item, for Packaging Fee / Keg Cleaning / Forklift
/ Bulk Discount:

```sql
create table public.export_service_mappings (
  id                            uuid primary key default gen_random_uuid(),
  service_type                  text not null check (service_type in (
                                   'packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount'
                                 )),
  partner_id                    uuid references public.contract_brewing_partners(id) on delete cascade,
  packaging_item_id             uuid references public.packaging_items(id) on delete cascade,
  square_catalog_item_id        text,
  square_catalog_variation_id   text,
  square_catalog_discount_id    text,
  display_name                  text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (service_type, partner_id, packaging_item_id),
  check (
    (service_type = 'packaging_fee' and packaging_item_id is not null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type in ('keg_cleaning', 'forklift') and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type = 'bulk_discount' and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null)
  )
);
```

Notes:
- `partner_id is null` represents the **default/global** row for that
  `service_type` (and `packaging_item_id`, for `packaging_fee`).
- For `packaging_fee`, `packaging_item_id` references the *same*
  `packaging_items` row that `export_transactions.packaging_item_id`
  already references — confirmed this is the correct granularity, since
  it's exactly the dimension the Export Bay Ship UI lets the user choose,
  and what gets recorded as the source of truth on `export_transactions`.
  (`export_transactions.variant_label` is a cached display string alongside
  `packaging_item_id`, not an independent dimension — so no separate variant
  key is needed here.)
- For `keg_cleaning` and `forklift`, there is no packaging variation —
  `packaging_item_id` stays `null`, and lookup is purely
  `(service_type, partner_id)`.
- `bulk_discount` maps to a Square **Discount** catalog object
  (`square_catalog_discount_id`), a different object type than items/
  variations, hence the separate column and CHECK branch. Folding it into
  this table (rather than a one-row `system_settings` entry) keeps the door
  open for future per-customer discount overrides or additional discount
  types without a schema change — the table already supports that via the
  existing `partner_id` column.

**Lookup convention** (for Spec 6 to implement later, documented here so the
intent is preserved): look up the partner-specific row first
(`partner_id = <customer>`, plus `packaging_item_id` for `packaging_fee`);
if none exists, fall back to the default row (`partner_id is null`) for the
same `service_type` (and `packaging_item_id`, for `packaging_fee`).

## UI / Navigation

- **New "Settings" tab under Production > Export**
  (`app/production/components/ExportTab.tsx`, alongside Export Bay /
  Distribution / Contract Brewing), rendering a shared `ExportSettingsPanel`
  component with three sections:
  1. Excise Tax Rates — CRUD (name, receiving party, unit, rate, active flag,
     Square item/variation mapping).
  2. Service Mappings — Packaging Fee / Keg Cleaning / Forklift, each with a
     default row plus optional per-partner override rows.
  3. Bulk Discount — default row plus optional per-partner override rows
     (same `export_service_mappings` table, `service_type = 'bulk_discount'`).
- **New "Excise Tax" sub-tab under Finance > Settings**
  (`app/finance/settings/SettingsNav.tsx`, alongside chart-of-accounts /
  account-mapping / import), rendering the *same* `ExportSettingsPanel`
  component with a `scope="excise-only"` prop that renders only section 1
  (Excise Tax Rates) and hides sections 2–3. One component, two entry points,
  no duplicated UI code.
- **`SquareCatalogSelect`**: new reusable Square item/variation picker
  component, modeled on Finance's existing `AccountSelect` dropdown pattern
  (`app/finance/settings/account-mapping/page.tsx`), backed by
  `lib/square/catalog.ts`'s `fetchCatalogItems` / `buildVariationNameMap`.
  A parallel discount picker is needed for `bulk_discount` rows — the
  planning phase must confirm what Square Catalog API call exposes discount
  objects (likely also via `fetchCatalogItems` filtering on object type, or
  a dedicated catalog search call) before finalizing this component's
  implementation.
- **Role gating**: write access restricted to exactly `{brewer, admin}` —
  explicitly **excluding** `manager` (taproom-scoped, no production access)
  and `viewer` (read-only). Reads open to all authenticated roles. This
  requires `lib/auth.ts`'s `requireRole` to support an explicit allowed-role
  set rather than its current linear-rank `minRole` comparison — see
  `docs/superpowers/plans/2026-06-21-fix-auth-role-hierarchy.md` for why the
  current implementation can't express this rule and must be fixed first
  (or as the first task of this spec's implementation plan).

## API Routes

- `GET/POST/PATCH/DELETE /api/production/export-settings/excise-tax-rates` —
  CRUD for `excise_tax_rates` rows.
- `GET/PUT /api/production/export-settings/service-mappings` — list/upsert
  `export_service_mappings` rows, filterable by `service_type` and/or
  `partner_id`.
- `GET /api/production/export-settings/square-catalog` — proxy for fetching
  Square catalog items/variations/discounts for the picker dropdowns (reuses
  `lib/square/catalog.ts`).
- All write routes gated to roles `{brewer, admin}` exactly; reads open to
  all authenticated roles.

## Explicit Non-Goals

- No invoice-generation logic. Nothing in this spec reads
  `export_service_mappings` or the new `excise_tax_rates` columns to actually
  build a Square invoice — that's Spec 6's job in a future session.
- No changes to `export_transactions` status flow (`Invoice Required` /
  `Unpaid` statuses described during Spec 6 brainstorming are not part of
  this spec).
- No changes to `commitments` or `batch_allocations` schemas.
