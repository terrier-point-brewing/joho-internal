# Tax Rates Table + Registrations Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One agent per locality group (G0–G7), sequential steps within a group, per-task Sonnet review (findings-only), final Opus whole-branch review. Steps use `- [ ]` tracking.

**Goal:** Replace scattered rate constants + the free-form `excise_tax_rates` editor with one canonical `tax_rates` table, and rework Tax Profile (lower-grain registrations + EIN) and Tax Filing (module-pivoted, no rate editing).

**Execution Budget:** Mode = subagent-driven-development. Spawn cap = 10 (8 groups + 2). Token target ≈ 500k. Executor STOPS and reports before exceeding the cap. Migration is **author-only, human-gated** — never applied by an agent.

**Architecture:** Rate *structure/keys* stay in code (module contract via `lib/tax/rates.ts` key constants); rate *values* live in `tax_rates` (evolved in-place from `excise_tax_rates` to preserve the `export_transaction_taxes` FK). Every module + production reads rates through one accessor, by key.

**Tech Stack:** Next.js 16 App Router, TS, Supabase Postgres, react-query, Vitest. Auth via `lib/auth` (`requireRole`). API via `requireDateRange`/`apiError` patterns.

**Design spec (authoritative):** `docs/superpowers/specs/2026-07-13-tax-rates-and-registrations-design.md`. Read the spec's "Current-state facts" once; do not re-derive.

## Global Constraints

- **UI:** UI_STANDARD — token utilities only (no raw `zinc/amber/red/green/blue/gray`/hex), `.btn-*`/`.inp`/`.inp-sm`, `<Card>`/`<Banner>`/`<PageHeader>`/`<Field>` primitives. No hand-rolled buttons/inputs.
- **`lib/` modules ship co-located `*.test.ts`** covering pure logic; keep coverage ≥ `vitest.config.ts` floor. CI runs `npm run verify` (lint + typecheck + tests) — the per-task DoD.
- **Supabase client per context:** route handlers → `createSupabaseAdminClient` (admin) or server client; never the browser client server-side.
- **Money/rate math:** rates are decimal (e.g. `0.6171`, `0.0475`); reuse `lib/money` for cent snapping in production excise. Do not change stored-figure rounding behavior.
- **Migration:** single new file `supabase/migrations/20260720_tax_rates_and_registrations.sql` (pick the next unused date-prefix at author time if 20260720 is taken). Idempotent DDL; run-once policy pattern (no `CREATE POLICY IF NOT EXISTS`). **Do not apply.**

## Task table

| G | Task | Model | Depends on |
|---|------|-------|-----------|
| G0 | Migration: `tax_rates` evolution + `tax_registrations` + authority/entity column drops + seed | Sonnet | — |
| G1 | Tax Profile server: authorities/registrations/entity libs + routes + query-keys | Sonnet | — |
| G2 | Tax Profile UI: RegistrationsSection rewrite + page | Sonnet | G1 |
| G3 | Rates core: `lib/tax/rates.ts` accessor + key constants + `/api/tax/rates` + query-keys | Sonnet | — |
| G4 | Production excise rewire → read `tax_rates` (verify export writer/preview) | Sonnet | G3 |
| G5 | Beer-excise module rewire → `getTaxRate` | Sonnet | G3 |
| G6 | Sales&Use engine refactor → rate-map param + `referenceView` contract + parties route | Sonnet | G3 |
| G7 | Sales&Use client + Tax Filing page + Export panel read-only excise | Sonnet | G6 |

Order: **G0, G1→G2** (profile chain) and **G3→{G4,G5,G6}→G7** (rates chain) are independent chains; within a chain, respect `Depends on`. G0 blocks nothing at code/test time (tests mock Supabase).

---

## G0 — Migration (author-only)

**Files:** Create `supabase/migrations/20260720_tax_rates_and_registrations.sql`.

**Steps:**
- [ ] Evolve `excise_tax_rates` → `tax_rates` in-place: `ALTER TABLE ... RENAME TO tax_rates`; `RENAME COLUMN unit TO basis` + drop old check, add check `basis in ('per_bbl','per_gallon','percent')`, `UPDATE` values `bbl→per_bbl`/`gallon→per_gallon`; `RENAME COLUMN rate_usd TO rate`; `ADD COLUMN key text`, `ADD COLUMN category text`; `DROP COLUMN receiving_party, square_catalog_item_id, square_catalog_variation_id`.
- [ ] Backfill excise rows: set `key`,`category='excise'`,`party_key` for the 2 rows; **update NC row `rate=0.6171`** (was 0.62); then `ALTER COLUMN key SET NOT NULL`, `ADD CONSTRAINT tax_rates_key_unique UNIQUE (key)`, `ALTER COLUMN category SET NOT NULL`.
- [ ] Seed sales rows (`category='sales'`, `party_key='nc_dor'`, `basis='percent'`): `nc_sales_state=0.0475`, `nc_sales_line_4..line_12` from `RATE_BY_LINE` (`lib/tax/parties/ncDorSalesUse/rates.ts`).
- [ ] Seed county rows: for each of the 100 counties, `nc_local_{CODE}` (`category='local'`) and, where transit>0, `nc_transit_{CODE}` (`category='transit'`), values = resolved `NC_COUNTY_TIERS` output. **Generate the row list from `rates.ts` constants** (write a throwaway node/tsx snippet in scratchpad to print the INSERT rows; do NOT hand-type 100+ rows).
- [ ] Create `tax_registrations` (`id uuid pk default gen_random_uuid()`, `authority_key text not null references tax_authorities(key) on delete cascade`, `label text not null`, `number text`, `display_order int not null default 0`, `updated_at timestamptz not null default now()`) + finance-reader RLS policy mirroring `tax_authorities`.
- [ ] Seed authorities `('irs','Internal Revenue Service',0)`, `('nc_abc','North Carolina Alcoholic Beverage Control Commission',<next order>)` via `insert ... on conflict (key) do nothing` (omit `kind`).
- [ ] Backfill registrations: from every `tax_authorities.registration_number is not null` → `tax_registrations(authority_key, label='Account / License #', number)`; from `tax_entity_profile.fein` → `tax_registrations(authority_key='irs', label='Federal EIN (FEIN)', number)`.
- [ ] Drop columns **after** backfill: `tax_authorities.kind`, `tax_authorities.registration_number`, `tax_entity_profile.fein`. Add column comments.

**Acceptance:** SQL parses; ordering (backfill before drops) correct; `export_transaction_taxes.excise_tax_rate_id` FK untouched (same table id). **Not applied.** Update memory-relevant note that human must apply.

---

## G1 — Tax Profile server

**Files:** Modify `lib/tax/authorities.ts`, `lib/tax/entity.ts`, `app/api/tax/authorities/route.ts`, `lib/query-keys.ts`. Create `lib/tax/registrations.ts` + `lib/tax/registrations.test.ts`, `app/api/tax/registrations/route.ts`.

**Interfaces produced:**
- `TaxAuthority = { key, label, display_order }` (drop `kind`,`registration_number`).
- `TaxRegistration = { id, authority_key, label, number, display_order }`.
- `listRegistrations(sb): Promise<TaxRegistration[]>` (order authority_key, display_order).
- `saveRegistrations(sb, rows: TaxRegistrationInput[]): Promise<void>` — bulk reconcile.
- `reconcileRegistrations(existingIds: string[], incoming: {id?:string}[]): { deleteIds: string[] }` — **pure**, unit-tested.
- `GET/PUT /api/tax/registrations`; query-key `tax.registrations()`.

**Steps:**
- [ ] `authorities.ts`: trim `TaxAuthority` + `listAuthorities` select to `key,label,display_order`; delete `updateRegistration`.
- [ ] `entity.ts`: remove the `fein` entry from `ENTITY_PROFILE_SCHEMA`.
- [ ] `registrations.ts` + test: write failing pure-reconcile tests (incoming without id → insert; existing id absent from incoming → delete; present → update) → implement `reconcileRegistrations` + `list/saveRegistrations` (save = derive deleteIds, `delete().in('id',deleteIds)`, `upsert` the rest with `updated_at`). Run tests green.
- [ ] `app/api/tax/registrations/route.ts`: `GET` (`requireRole(["manager"])`) → list; `PUT` (`requireRole([])` admin) → `saveRegistrations`; `apiError` wrapping; `dynamic="force-dynamic"`.
- [ ] `app/api/tax/authorities/route.ts`: delete the `PATCH` handler; keep `GET`.
- [ ] `query-keys.ts`: add `registrations: () => ["tax","registrations"] as const`.
- [ ] `npm run verify` green; commit.

**Acceptance:** reconcile logic covered; authorities route no longer edits registration numbers; entity schema has no `fein`.

---

## G2 — Tax Profile UI

**Files:** Rewrite `app/finance/settings/tax-profile/RegistrationsSection.tsx`; touch `app/finance/settings/tax-profile/page.tsx` (copy only — EIN now lives in Registrations).

**Interfaces consumed:** `GET /api/tax/authorities`, `GET/PUT /api/tax/registrations`, `queryKeys.tax.authorities/registrations`.

**Steps:**
- [ ] Rewrite RegistrationsSection: fetch authorities + registrations; local draft state `Record<authority_key, Row[]>` where `Row = {id?, label, number}`; render grouped by authority (heading = authority label), each row `<input class="inp-sm">` label + number + a `.btn-secondary btn-xxs` Remove; **+ Add registration** per authority; one **Save** (`.btn-primary`) → `PUT` flattened rows (assign `display_order` by index), then invalidate both query keys; `<Banner tone="danger">` on error, `<Banner tone="success">` on save. No blur-commit.
- [ ] page.tsx: keep Filer Identity + Registrations sections; adjust the Registrations section description if it references "type"/per-authority number. No structural change.
- [ ] `npm run verify` green; commit.

**Acceptance:** explicit Save persists all rows (create/edit/delete); IRS shows the FEIN registration; NC ABC group present; no "Type" column.

---

## G3 — Rates core

**Files:** Create `lib/tax/rates.ts` + `lib/tax/rates.test.ts`, `app/api/tax/rates/route.ts`. Modify `lib/query-keys.ts`.

**Interfaces produced:**
- `type TaxRate = { id, key, name, category: 'excise'|'sales'|'local'|'transit', party_key: string|null, basis: 'per_bbl'|'per_gallon'|'percent', rate: number, is_active: boolean }`.
- `TAX_RATE_KEYS` const (e.g. `NC_DOR_BEER_EXCISE='nc_dor_beer_excise'`, `FEDERAL_BEER_EXCISE='federal_beer_excise'`, `NC_SALES_STATE='nc_sales_state'`), `ncSalesLineKey(n)`, `ncLocalKey(code)`, `ncTransitKey(code)`.
- `listTaxRates(sb, opts?: { category?; activeOnly?: boolean }): Promise<TaxRate[]>`.
- `getTaxRate(sb, key): Promise<number|null>` (active row's `rate`).
- `buildRateMap(rows: TaxRate[]): Record<string, number>` — **pure**, unit-tested.
- `GET /api/tax/rates?category=` (manager+); query-key `tax.rates(category?)`.

**Steps:**
- [ ] Write failing tests: key builders return exact strings; `buildRateMap` collapses rows→`{key:rate}`; `listTaxRates` category filter (mock sb).
- [ ] Implement `rates.ts`; select `id,key,name,category,party_key,basis,rate,is_active` from `tax_rates`. Run green.
- [ ] `app/api/tax/rates/route.ts`: `GET` manager+, optional `?category`, `apiError`, `dynamic`.
- [ ] `query-keys.ts`: `rates: (category?: string) => category ? ["tax","rates",category] : ["tax","rates"] as const`.
- [ ] verify green; commit.

---

## G4 — Production excise rewire (high-risk: export invoicing)

**Files:** Modify `lib/production/exciseTax.ts` + `lib/production/exciseTax.test.ts`. Read-verify (no change expected) `lib/production/exportTransactionWriter.ts`, `lib/production/exportInvoicePreview.ts`.

**Interfaces consumed:** `listTaxRates` (G3). **Produces:** unchanged `computeExciseTaxBreakdown(sb, volumeBbl): Promise<ExciseTaxLine[]>` shape (`rateId,name,unit,rateUsd,amountUsd`).

**Steps:**
- [ ] Update tests: excise breakdown sourced from `tax_rates` (`category='excise'`, active); assert Federal `3.50/bbl` + NC `0.6171/gal` produce cent-snapped amounts; `rateId` still = row `id`; keep `unit` field mapping (`per_bbl→bbl`,`per_gallon→gallon`) so downstream `ExciseTaxLine.unit` and stored rows are unchanged.
- [ ] Reimplement `computeExciseTaxBreakdown` via `listTaxRates(sb,{category:'excise',activeOnly:true})`; map `basis`→units, `rate`→amount with the **same `centsToDollars(dollarsToCents(...))` snap**. Preserve `ExciseTaxLine.unit: 'bbl'|'gallon'` and `rateUsd` names.
- [ ] Read `exportTransactionWriter`/`exportInvoicePreview`: confirm they only depend on `ExciseTaxLine` fields + `excise_tax_rate_id`/name join — no code change; note in commit if a tweak was needed.
- [ ] verify green; commit.

**Acceptance:** export excise figures identical to pre-change except NC 0.62→0.6171; stored `excise_tax_rate_id` linkage preserved.

---

## G5 — Beer-excise module rewire

**Files:** Modify `lib/tax/parties/ncDorBeerExcise/calc.ts` + its test; `lib/tax/parties/ncDorBeerExcise/rates.ts` (+ test) for reference-text sourcing.

**Interfaces consumed:** `getTaxRate` (G3), `TAX_RATE_KEYS.NC_DOR_BEER_EXCISE`.

**Steps:**
- [ ] Update calc test: rate now from `getTaxRate(sb,'nc_dor_beer_excise')`→micros; `NC_EXCISE_RATE_MICROS_FALLBACK` only when null; keep the rate-vs-invoiced reconciliation warning behavior.
- [ ] Replace `fetchNcRateMicros`'s ad-hoc `excise_tax_rates` query with `getTaxRate`; keep `usdToMicros` + fallback.
- [ ] `rates.ts`: keep `NC_EXCISE_RATE_USD_PER_GALLON`/`_MICROS_FALLBACK` (fallback + seed source) + `TAXABLE_CHANNELS`; `BEER_EXCISE_REFERENCE`'s rate note should say the value is the canonical `tax_rates` row (adjust wording; if the reference must show the live number, have the parties route inject it — see G6). Update the note text.
- [ ] verify green; commit.

---

## G6 — Sales&Use engine refactor (rate-map + referenceView contract)

**Files:** Modify `lib/tax/parties/ncDorSalesUse/{rates,derive,calc,template}.ts` + their tests; `lib/tax/types.ts` (`TaxPartyTemplate.referenceView`); `app/api/tax/parties/route.ts`.

**Interfaces produced:**
- `deriveNcDorFigures(fields, rateMap: Record<string,number>): WorksheetFields` (add param; all callers updated).
- `TaxPartyTemplate` — change `referenceView: ReferenceSpec` → `buildReferenceView(rateMap: Record<string,number>): ReferenceSpec` (rename to avoid a stale static field). Beer + Sales modules implement it; parties route calls it.
- `ncDorSalesUse/rates.ts` — keeps county list/codes + `ncCode`, `RATE_LINES`, `RateLineKey`, `countyRateLine`/`transitRateLine` (derive line from resolved rate value); **rate values removed**; add `ncLocalKey`/`ncTransitKey`/`ncSalesLineKey` re-exports if not centralized in G3.

**Steps:**
- [ ] `rates.ts`: delete `NC_STATE_RATE` value use / `RATE_BY_LINE` values / `NC_COUNTY_TIERS` values + tier-precedence sets; keep structural exports; `countyRateLine(localRate)`/`transitRateLine(transitRate)` now take numbers. Update tests to structural assertions.
- [ ] `derive.ts` + test: add `rateMap` param; look up state/line/county rates by key from the map (falling back to 0 if absent → warning-safe). Failing test first (seed a known rateMap, assert figures match previous constant-based expectations), then implement.
- [ ] `calc.ts` + test: fetch rates server-side (`listTaxRates(sb,{...})`→`buildRateMap`), pass into derive/merge; `computeNcDorWorksheet(ctx)` now builds the rate map.
- [ ] `template.ts` + test: `mergeWorksheet` threads the rate map (fetch inside, or accept via closure); replace static `referenceView` with `buildReferenceView(rateMap)` (state table + county tiers rendered from the map).
- [ ] `types.ts`: update `TaxPartyTemplate` contract (`buildReferenceView`); update beer module (G5) to satisfy it (its ref uses the excise rate from the map).
- [ ] `app/api/tax/parties/route.ts`: fetch rates once (`listTaxRates`→`buildRateMap`), call each party's `buildReferenceView(rateMap)`; serialize as before.
- [ ] verify green; commit.

**Acceptance:** server compute + merge produce identical figures for the seeded rate map; reference tables render from DB values.

---

## G7 — Sales&Use client + Tax Filing page + Export panel

**Files:** Modify `app/finance/tax/parties/NcDorSalesUse/Worksheet.tsx`; `app/finance/settings/tax-filing/page.tsx`; `app/production/components/ExportSettingsPanel.tsx`; dispose `app/finance/settings/tax-filing/ExciseRatesSection.tsx`.

**Interfaces consumed:** `GET /api/tax/rates?category=…` + `queryKeys.tax.rates`, refactored `deriveNcDorFigures(fields, rateMap)` (G6).

**Steps:**
- [ ] Worksheet.tsx: fetch the sales rate map via react-query (`categories sales+local+transit`, or one call + client `buildRateMap`); pass `rateMap` into every live `deriveNcDorFigures` call; loading/error via existing patterns. Verify live recompute parity.
- [ ] tax-filing/page.tsx: rewrite axis → **module** (`useTaxPartiesQuery`): selector over parties; per module render `IdentityForm(settingsSchema)` + `ReferenceDisclosure(referenceView)` + Schedules link. Remove `TEMPLATE_BY_AUTHORITY`, authorities query, Excise Rates section, `kind` gate.
- [ ] ExportSettingsPanel.tsx: make the excise section **read-only** — render fixed rows from `tax_rates` (name/basis/rate), drop add/edit/toggle. Reuse a read-only table.
- [ ] ExciseRatesSection.tsx: if no editable consumer remains, delete it (and any now-unused `useExciseTaxRatesQuery` create/patch paths) or reduce to a read-only presentational component — pick the smaller diff.
- [ ] verify green; commit.

**Acceptance:** module-per-pane Tax Filing; reference shows NC excise 0.6171; no rate editing anywhere; client worksheet figures unchanged vs pre-change for current rates.

---

## Post-execution
- [ ] Final **Opus** whole-branch review (correctness + parity of G4/G6/G7; historical FK safety). Fix Critical/Important.
- [ ] Update memory project note (registrations + tax_rates; migration `20260720…` PENDING human apply).
- [ ] Open PR (base `main`); flag migration as human-gated in the PR body.

## Self-review notes
- Spec coverage: Parts 1/2/3 → G1-G2 / G2+G7 / G0+G3-G7. ✅
- Historical FK safety (rename-in-place) → G0 + G4 acceptance. ✅
- Client live-recompute parity → G6 (engine) + G7 (wiring) with seeded-rateMap tests. ✅
- `referenceView` becoming dynamic → contract change isolated in G6, consumed by parties route + beer/sales modules. ✅
