# Tax Rates Table + Registrations Rework — Design Spec

**Date:** 2026-07-13
**Branch:** `claude/tax-profile-issues-10c76e`
**Status:** Approved design → ready for implementation plan

## Goal

Rework Finance → Settings tax config into three coordinated changes:

1. **Tax Profile** — explicit-save Registrations at a lower grain (authority → N
   registrations), Federal EIN moved in as a registration, "type" enum dropped,
   NC ABC Commission added.
2. **Tax Filing** — pane per *tax module* (party template) instead of per
   authority; no user-editable rates.
3. **Canonical `tax_rates` table** — a single referenceable rate registry
   (general beyond excise), consumed by every module and by production, replacing
   both the free-form `excise_tax_rates` editing UI and the per-module rate code
   constants.

Rates' **structure/keys live in code** (module contract); rate **values live in
the table** (editable data). Modules refer to a rate **by key**, never by
reaching into another module's constants.

## Non-goals

- Building the constrained rate-**value editor** UI. Near-term the rates surface
  **read-only** (reference display). "Eventually editable" is a follow-up.
- Effective-dated rate history. The table holds the single current value;
  historical filings/invoices already snapshot the applied rate at compute time
  (`export_transaction_taxes.rate_usd`, persisted worksheets).

---

## Current-state facts (verified)

- **`excise_tax_rates`** (`supabase/migrations/20260622_export_transactions.sql`):
  `id uuid pk, name, receiving_party, unit ('bbl'|'gallon'), rate_usd numeric,
  is_active`, plus `square_catalog_item_id/variation_id`
  (`20260624`, **vestigial** — no excise consumer reads them) and `party_key text
  → tax_authorities(key)` (`20260713`). Seeded: `('Federal Excise Tax','TTB','bbl',3.50)`,
  `('NC Excise Tax','NC Department of Revenue','gallon',0.62)`. **NC value is
  stale — should be 0.6171.**
- **Consumers of `excise_tax_rates`:**
  - `lib/production/exciseTax.ts::computeExciseTaxBreakdown(sb, volumeBbl)` — reads
    all active rows, applies `rate_usd × units`. Called by
    `lib/production/exportTransactionWriter.ts` at export-write time.
  - `lib/production/exportInvoicePreview.ts::buildExciseTaxLines` — reads stored
    `export_transaction_taxes` and joins `excise_tax_rates` for the **name** only.
  - `lib/tax/parties/ncDorBeerExcise/calc.ts::fetchNcRateMicros` — reads the active
    NC gallon row live; falls back to `NC_EXCISE_RATE_MICROS_FALLBACK`
    (`rates.ts`); emits a rate-drift warning.
  - `app/finance/settings/tax-filing/ExciseRatesSection.tsx` — free-form editable
    table (add/edit/toggle rows). Shared by `app/production/components/ExportSettingsPanel.tsx`.
- **`export_transaction_taxes.excise_tax_rate_id uuid → excise_tax_rates(id) on
  delete set null`** — load-bearing FK on historical export data. **The table
  must keep the same `id` identity** → evolve via `ALTER TABLE ... RENAME`, never
  drop+recreate.
- **Sales & Use rates** live as **code constants** in
  `lib/tax/parties/ncDorSalesUse/rates.ts`: `NC_STATE_RATE=0.0475`, `RATE_BY_LINE`
  (lines 4–12), `NC_COUNTY_TIERS` (100 counties via tier-precedence sets),
  `countyRateLine`/`transitRateLine`. Consumed **server-side**
  (`calc.ts`, `derive.ts`) **and client-side**
  (`app/finance/tax/parties/NcDorSalesUse/Worksheet.tsx` live recompute imports the
  same pure `derive.ts`/`fieldOwnership.ts`, which import `rates.ts`). Surfaced
  read-only via `template.ts::referenceView` (static, built at module load).
- **Party/module abstraction:** `TaxPartyTemplate` (`lib/tax/types.ts`), registered
  via `lib/tax/registry.ts` (`registerParty`/`listParties`/`getParty`), side-effect
  import barrel `lib/tax/parties/index.ts`. `GET /api/tax/parties` already serializes
  every module's `key/label/settingsSchema/scheduleConfigSchema/referenceView/...`.
- **`tax_authorities`** (`20260713`): `key pk, label, kind
  ('filing'|'excise'|'both'), registration_number, display_order`. `kind`'s ONLY
  functional use is gating the excise section on the Tax Filing page (removed in
  Part 2 → `kind` becomes dead). `registration_number` is 1:1 per authority
  (moved to `tax_registrations` in Part 1).
- **`tax_entity_profile`** (`20260713`, singleton `id=true`): filer identity incl.
  `fein` (**no runtime consumer** — safe to relocate) and `ssn` (sensitive).
  Schema `ENTITY_PROFILE_SCHEMA` in `lib/tax/entity.ts`.

---

## Part 1 — Tax Profile (Registrations + EIN)

### Schema (migration)
- **New `tax_registrations`**: `id uuid pk default gen_random_uuid()`,
  `authority_key text not null → tax_authorities(key) on delete cascade`,
  `label text not null`, `number text`, `display_order int not null default 0`,
  `updated_at timestamptz not null default now()`. RLS: finance-reader policy,
  mirroring `tax_authorities`.
- **Seed authorities:** `('irs','Internal Revenue Service', …)`,
  `('nc_abc','North Carolina Alcoholic Beverage Control Commission', …)` (drop
  `kind` from the insert — see below).
- **Backfill registrations:** for each `tax_authorities` row with a non-null
  `registration_number`, insert a `tax_registrations` row
  (`label='Account / License #'`, `number=registration_number`). For
  `tax_entity_profile.fein` (if present), insert one under `authority_key='irs'`,
  `label='Federal EIN (FEIN)'`.
- **Drop columns:** `tax_authorities.kind`, `tax_authorities.registration_number`,
  `tax_entity_profile.fein`.

### Code
- `lib/tax/authorities.ts` — `TaxAuthority` drops `kind` + `registration_number`;
  `listAuthorities` select trimmed; delete `updateRegistration`.
- `lib/tax/registrations.ts` (**new**, + test): `TaxRegistration` type;
  `listRegistrations(sb): TaxRegistration[]` (ordered authority_key, display_order);
  `saveRegistrations(sb, rows)` — **bulk reconcile**: upsert provided rows (by id),
  delete existing rows whose id is absent from the payload. Pure reconcile helper
  unit-tested (diff → {upserts, deleteIds}).
- `lib/tax/entity.ts` — remove `fein` from `ENTITY_PROFILE_SCHEMA`.
- `app/api/tax/registrations/route.ts` (**new**): `GET` (manager+) → list;
  `PUT` (admin) → `saveRegistrations`. Use `apiError`.
- `app/api/tax/authorities/route.ts` — drop the `PATCH` (registration edit) handler;
  keep `GET` list.
- `lib/query-keys.ts` — add `tax.registrations()`.

### UI
- `app/finance/settings/tax-profile/RegistrationsSection.tsx` — rewrite:
  fetch authorities + registrations; render grouped by authority; each row
  `[label .inp-sm][number .inp-sm][remove]`; **Add registration** per authority;
  single **Save** → `PUT`. Local draft state; explicit save (no blur-commit).
  Follow UI_STANDARD (Card, Banner, token utilities, `.btn-*`).
- `app/finance/settings/tax-profile/page.tsx` — Filer Identity section unchanged
  (EIN now absent via schema); Registrations section now owns EIN.

---

## Part 2 — Tax Filing (module-pivoted)

- `app/finance/settings/tax-filing/page.tsx` — rewrite the axis from authority to
  **module**: selector lists `useTaxPartiesQuery()` entries (`GET /api/tax/parties`),
  each its own pane: **Module settings** (`IdentityForm` on `settingsSchema`) +
  **Reference Data** (`ReferenceDisclosure` on the module's DB-sourced
  `referenceView`) + Schedules link. Delete `TEMPLATE_BY_AUTHORITY`, the
  authority query, and the Excise Rates section/`kind` gate.
- `app/finance/settings/tax-filing/ExciseRatesSection.tsx` — remove its use here.
  **Also make `ExportSettingsPanel.tsx` excise display read-only** (drop add/edit;
  render fixed rows from `tax_rates`). If `ExciseRatesSection` is left with no
  editable consumer, reduce it to a read-only table or delete and inline a
  read-only view — implementer's call at plan time.
- Net effect: no rate editing anywhere; `tax_authorities.kind` fully unreferenced
  (dropped in Part 1 migration).

---

## Part 3 — Canonical `tax_rates` table

### Schema (one migration file — G0, covering Parts 1–3)
Evolve in place to preserve the `export_transaction_taxes` FK:
- `ALTER TABLE excise_tax_rates RENAME TO tax_rates`.
- `RENAME COLUMN unit TO basis` (widen check to `('per_bbl','per_gallon','percent')`;
  migrate values `'bbl'→'per_bbl'`, `'gallon'→'per_gallon'`).
- `RENAME COLUMN rate_usd TO rate`.
- `ADD COLUMN key text` (then backfill + `UNIQUE`), `ADD COLUMN category text`
  (`'excise'|'sales'|'local'|'transit'`, backfill, `NOT NULL`).
- `DROP COLUMN receiving_party, square_catalog_item_id, square_catalog_variation_id`.
- Keep `party_key`, `is_active`, `id`.
- Optionally rename `export_transaction_taxes.excise_tax_rate_id → tax_rate_id`
  (cosmetic; skip if it widens blast radius).

### Seed data (in migration)
- **Excise (category `excise`):** update the 2 existing rows →
  `key='federal_beer_excise'` (party `federal_ttb`, basis `per_bbl`, rate `3.50`),
  `key='nc_dor_beer_excise'` (party `nc_dor`, basis `per_gallon`, **rate `0.6171`**).
- **Sales (category `sales`, party `nc_dor`, basis `percent`):**
  `nc_sales_state=0.0475`, and per-form-line `nc_sales_line_4..line_12` from
  `RATE_BY_LINE`.
- **County (category `local`/`transit`, party `nc_dor`, basis `percent`):** one
  resolved `nc_local_{COUNTY_CODE}` and (where non-zero) `nc_transit_{COUNTY_CODE}`
  per county, values from the current tier-precedence output. Generate the seed
  from `rates.ts` constants (one-time); the migration hardcodes the resulting rows.

### Accessor + key contract
- `lib/tax/rates.ts` (**new**, + test): exported key constants
  (`TAX_RATE_KEYS`, county-key builders `ncLocalKey(code)`/`ncTransitKey(code)`);
  `listTaxRates(sb, { category? }): TaxRate[]`; `getTaxRate(sb, key): number|null`;
  `buildRateMap(rows): Record<string, number>`. `TaxRate` type:
  `{ id, key, name, category, party_key, basis, rate, is_active }`.
- `app/api/tax/rates/route.ts` (**new**): `GET` (manager+) → `listTaxRates`
  (optional `?category=`). `lib/query-keys.ts` — add `tax.rates(category?)`.

### Consumer rewiring
- **Production** `lib/production/exciseTax.ts::computeExciseTaxBreakdown` — read
  `listTaxRates(sb,{category:'excise'})` (active), compute from `rate`/`basis`.
  Behavior identical to today except source table + corrected NC rate. Verify
  `exportTransactionWriter` + `exportInvoicePreview` still resolve rate rows by
  `id` (unchanged).
- **Beer-excise filing** `lib/tax/parties/ncDorBeerExcise/calc.ts` — replace
  `fetchNcRateMicros`'s ad-hoc query with `getTaxRate(sb,'nc_dor_beer_excise')`;
  keep `NC_EXCISE_RATE_MICROS_FALLBACK` as last-resort only; keep rate-vs-invoiced
  reconciliation. `rates.ts` keeps the fallback constant + `BEER_EXCISE_REFERENCE`
  structure but the reference **rate text is derived from the DB value**.
- **Sales & Use worksheet — the big one:**
  - Refactor the pure engine to accept a **rate map** instead of importing rate
    values: `deriveNcDorFigures(fields, rateMap)` (and any calc helper that reads
    `RATE_BY_LINE`/`NC_COUNTY_TIERS`). `fieldOwnership.ts` is rate-independent —
    leave it. Update all call sites + tests.
  - `ncDorSalesUse/rates.ts` — **remove rate values** (`NC_STATE_RATE`,
    `RATE_BY_LINE` values, `NC_COUNTY_TIERS` values); **keep structure**: county
    list/codes/`ncCode`, key builders, and `countyRateLine`/`transitRateLine`
    (derive line from the resolved rate value: `0.0225→'10'`, `0.02→'9'`,
    `0.005→'11'`, `0.0025→'12'`). Delete the tier-precedence sets.
  - **Server** `calc.ts` / `template.ts` — fetch the rate map (server has `sb`),
    pass into derive/merge; make `referenceView` a **function of the rate map**
    (built in the parties route, which gains a rate fetch) instead of a static
    const. Update `TaxPartyTemplate.referenceView` contract accordingly (e.g.
    `referenceView(rateMap): ReferenceSpec` or `buildReferenceView`), and update
    `GET /api/tax/parties` to fetch rates once and build each module's reference.
  - **Client** `app/finance/tax/parties/NcDorSalesUse/Worksheet.tsx` — fetch the
    sales rate map via `GET /api/tax/rates?category=…` (react-query), pass into the
    live `deriveNcDorFigures` calls. Loading/error states via existing patterns.

---

## Locality groups (for the plan's spawn cap)

Group by file locality; tasks in a group run sequentially in one agent.

- **G0 — Migration** (single migration file; all schema + seed for Parts 1–3).
- **G1 — Tax Profile server** (`lib/tax/authorities.ts`, `lib/tax/registrations.ts`
  + test, `lib/tax/entity.ts`, `app/api/tax/registrations/route.ts`,
  `app/api/tax/authorities/route.ts`, `lib/query-keys.ts`).
- **G2 — Tax Profile UI** (`RegistrationsSection.tsx`, `tax-profile/page.tsx`).
- **G3 — Rates core** (`lib/tax/rates.ts` + test, `app/api/tax/rates/route.ts`,
  `query-keys`).
- **G4 — Production excise rewire** (`lib/production/exciseTax.ts` + test;
  verify `exportTransactionWriter`/`exportInvoicePreview`). *High-risk area.*
- **G5 — Beer-excise module rewire** (`ncDorBeerExcise/calc.ts`, `rates.ts` + tests).
- **G6 — Sales&Use engine refactor** (`ncDorSalesUse/{rates,derive,calc,template}.ts`
  + tests; `TaxPartyTemplate` contract in `types.ts`; `/api/tax/parties` route).
- **G7 — Sales&Use client + Tax Filing page** (`NcDorSalesUse/Worksheet.tsx`,
  `tax-filing/page.tsx`, `ExportSettingsPanel.tsx` read-only excise,
  `ExciseRatesSection.tsx` disposition).

Spawn cap = groups + 2. Migration is **human-gated** (author only; do not apply).
Final whole-branch review = Opus. Per-task review = Sonnet, findings-only.

## Acceptance criteria

- `npm run verify` green (lint + typecheck + tests), coverage floor held.
- Tax Profile: registrations save explicitly (bulk), grouped by authority; EIN
  editable as a registration under IRS; NC ABC present; no "type" column.
- Tax Filing: one pane per module; no rate editing; reference data reflects
  `tax_rates` values (NC excise shows 0.6171).
- Production export excise + beer-excise filing + Sales&Use worksheet (server
  compute AND client live recompute) all produce identical figures to pre-change,
  except the corrected NC excise rate, sourcing every rate from `tax_rates`.
- No code path reads rate *values* from `ncDorSalesUse/rates.ts` or the beer
  fallback except as documented fallback/structure.
- `tax_authorities.kind`, `.registration_number`, `tax_entity_profile.fein`,
  and the excise Square-mapping columns are gone; `export_transaction_taxes`
  historical FK intact.

## Risks

- **Export invoicing** (`exportTransactionWriter`) is high-risk; excise amounts
  feed stored export tax rows. Rewire must be figure-identical (bar the NC rate).
- **Client live recompute** parity: the refactored `deriveNcDorFigures(fields,
  rateMap)` must match prior output for the same rates — cover with tests seeding
  the known rate map.
- **Beer-excise branch (#179)** is merged (`de1cdf1`); branch fast-forwarded onto it.
