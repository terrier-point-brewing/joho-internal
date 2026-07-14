# Tax Settings Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse Finance → Settings' two tax subtabs (Excise Tax, Tax Filing) into a general-vs-specific split — a new entity-level **Tax Profile** subtab and a per-receiving-party **Tax Filing** subtab that absorbs Excise — backed by a structured receiving-party spine.

**Architecture:** Introduce a `tax_authorities` table as the receiving-party spine (NC DOR, Federal TTB), a singleton `tax_entity_profile` for filer-level identity (legal name, FEIN, SSN, contact, address), and give `excise_tax_rates` a `party_key` FK. Identity fields leave the per-party `tax_filing_profiles` (which slims to party-operational settings only, e.g. the Square sales-tax mapping). The UI splits into `tax-profile` (entity + registrations) and `tax-filing` (per-party: Square mappings + excise rates + statutory references + schedules link).

**Tech Stack:** Next.js 16 (App Router, TS), Tailwind v4, Supabase Postgres (service-role admin client), TanStack Query, Vitest.

**Execution Budget:** Mode = subagent-driven-development, **consolidated to ONE subagent per locality group** (not per task — the user has hit context-tax from over-spawning micro-tasks). Spawn plan = **5 group-spawns**; cap = 7. Token target ≈ 350k. Each group's subagent runs its tasks sequentially; orchestrator reviews between groups.

**Spawn grouping (one `impl` subagent each, sequential — dependencies: A→B→C, then D, then E):**
- **Spawn 1 (Opus):** Task 1 — migration file.
- **Spawn 2 (Sonnet):** Tasks 2+3 — `lib/tax/entity.ts`, `lib/tax/authorities.ts` (+ tests, query-keys).
- **Spawn 3 (Sonnet):** Tasks 4+5+6 — the three API routes.
- **Spawn 4 (Sonnet):** Tasks 7+8 — generalize `IdentityForm`, Tax Profile page + registrations + nav.
- **Spawn 5 (Sonnet):** Tasks 9+10 — relocate `ExciseRatesSection`, restructure Tax Filing page, retire Excise subtab.

## Global Constraints

- **Migrations are human-gated.** Tasks write migration files to `supabase/migrations/`; they are NEVER applied to prod by an agent. The orchestrator applies per-migration only after explicit user OK + backup. No `apply_migration` / `execute_sql` against the live DB in any task.
- **Supabase client by context:** route handlers use `createSupabaseAdminClient()` (`lib/supabase/admin.ts`); never the browser client in a route.
- **Auth:** role checks via `lib/auth.ts` `requireRole(...)`. Reads that touch finance data use the admin client behind a manager+ gate; writes are admin-gated (`requireRole([])` = admin-only, matching the existing profile PUT).
- **API routes:** wrap errors with `apiError()` from `lib/utils/api.ts`; `export const dynamic = "force-dynamic"`.
- **UI tokens only:** no raw `zinc/amber/red/green/blue/gray` utilities or hex. Use `.btn-primary`/`.btn-secondary`, `.inp`/`.inp-sm`, `<PageHeader>`, `<Card>`, `<Banner>`, `<SubNav>`, `<Field>`. (Note: the excise rate rows being relocated currently use raw `bg-surface-mid border-line-strong` utilities — those are token utilities and stay; do not introduce new raw colors.)
- **Sensitive fields** (FEIN, SSN) never leave the server in the clear — reuse the `maskSensitive` present/absent pattern from `lib/tax/profiles.ts`.
- **`lib/` modules ship with co-located `*.test.ts`** covering pure logic. CI runs `npm run test`; don't drop coverage below the `vitest.config.ts` floor. DoD command: `npm run verify`.
- **Party keys** (canonical): `nc_dor` (NC Department of Revenue — filing + excise) and `federal_ttb` (Alcohol and Tobacco Tax and Trade Bureau — excise). Note: the existing worksheet party-template key is `nc_dor_sales_use`; `tax_authorities.key` = `nc_dor` is the AUTHORITY, distinct from the filing-party-template key. The Tax Filing page keys its per-party sections off `tax_authorities`, and maps authority → worksheet template where one exists (see Task 9 mapping).

---

## File Structure

**Migrations**
- Create: `supabase/migrations/20260713_tax_settings_restructure.sql` — new tables + FK + backfill + slim.

**lib/tax (model + tests)**
- Create: `lib/tax/entity.ts` — `ENTITY_PROFILE_SCHEMA`, `getEntityProfile`, `putEntityProfile` (reuses `maskSensitive`).
- Create: `lib/tax/entity.test.ts`
- Create: `lib/tax/authorities.ts` — `TaxAuthority` type, `listAuthorities`, `updateRegistration`.
- Create: `lib/tax/authorities.test.ts`
- Modify: `lib/tax/identity.ts` — repurpose: `IDENTITY_SCHEMA` (contact/account/fein/ssn) is superseded by `ENTITY_PROFILE_SCHEMA`; keep only if still referenced, otherwise delete file and its imports.
- Modify: `lib/query-keys.ts` — add `queryKeys.tax.entityProfile()`, `queryKeys.tax.authorities()`.

**API routes**
- Create: `app/api/tax/entity-profile/route.ts` — GET (masked) / PUT (admin).
- Create: `app/api/tax/authorities/route.ts` — GET (list) / PATCH (registration_number).
- Modify: `app/api/production/export-settings/excise-tax-rates/route.ts` — optional `?party=<key>` filter on GET; accept `party_key` on POST.
- Modify: `app/api/production/export-settings/excise-tax-rates/[id]/route.ts` — accept `party_key` on PATCH.

**UI**
- Create: `app/finance/settings/tax-profile/page.tsx` — entity form + registrations.
- Create: `app/finance/settings/tax-profile/RegistrationsSection.tsx`
- Create: `app/finance/settings/tax-filing/ExciseRatesSection.tsx` — relocated from `ExportSettingsPanel`, party-filtered.
- Modify: `app/finance/settings/tax-filing/page.tsx` — per-authority layout; drop identity section; add excise + schedules link.
- Modify: `app/finance/settings/tax-filing/IdentityForm.tsx` — generalize to accept `endpoint` + `queryKey` (reused by entity profile).
- Modify: `app/finance/settings/SettingsNav.tsx` — replace `excise-tax` + `tax-filing` entries with `tax-profile` + `tax-filing`.
- Modify: `app/finance/settings/excise-tax/page.tsx` — redirect to `/finance/settings/tax-filing` (kept as a stub to avoid a dead bookmark), OR delete route dir. Default: redirect stub.
- Modify: `app/production/components/ExportSettingsPanel.tsx` — import the relocated `ExciseRatesSection` instead of a local copy (single source of truth); production export settings still render it under `scope`.

---

## Task Table

| # | Task | Group | Files | Model |
|---|------|-------|-------|-------|
| 1 | Migration: authorities spine + entity profile + excise FK + slim | A (DB) | `20260713_tax_settings_restructure.sql` | Opus |
| 2 | `lib/tax/entity.ts` + schema + tests | B (model) | entity.ts, entity.test.ts, query-keys | Sonnet |
| 3 | `lib/tax/authorities.ts` + tests | B (model) | authorities.ts, authorities.test.ts | Sonnet |
| 4 | Entity-profile API route | C (routes) | api/tax/entity-profile | Sonnet |
| 5 | Authorities API route | C (routes) | api/tax/authorities | Sonnet |
| 6 | Excise route: party filter + party_key writes | C (routes) | excise-tax-rates route + [id] | Sonnet |
| 7 | Generalize `IdentityForm` (endpoint param) | D (profile UI) | IdentityForm.tsx | Sonnet |
| 8 | Tax Profile page + Registrations + nav entry | D (profile UI) | tax-profile/*, SettingsNav | Sonnet |
| 9 | Relocate `ExciseRatesSection` (party-filtered) | E (filing UI) | ExciseRatesSection.tsx, ExportSettingsPanel | Sonnet |
| 10 | Restructure Tax Filing page + retire Excise subtab | E (filing UI) | tax-filing/page.tsx, excise-tax redirect, SettingsNav | Sonnet |

Escalate to Opus only per CLAUDE.md triggers (none expected here except Task 1's data migration, already Opus).

---

## Task 1: Migration — authorities spine, entity profile, excise FK, slim profiles

**Files:**
- Create: `supabase/migrations/20260713_tax_settings_restructure.sql`

**Interfaces:**
- Produces (schema later tasks rely on):
  - `tax_authorities(key text PK, label text not null, kind text check in ('filing','excise','both'), registration_number text, display_order int not null default 0, updated_at timestamptz)`
  - `tax_entity_profile(id boolean PK default true check (id), legal_name text, fein text, ssn text, contact_name text, contact_email text, contact_phone text, address_line1 text, address_line2 text, city text, state text, postal_code text, updated_at timestamptz)` — singleton via the `id` boolean-PK trick (only one row, `id = true`).
  - `excise_tax_rates.party_key text references public.tax_authorities(key)` (nullable; keep legacy `receiving_party` column populated for export-invoice compatibility).
  - `tax_filing_profiles` unchanged in shape; identity keys removed from its `values` jsonb by the backfill.

**Acceptance criteria:**
- Idempotent (`create table if not exists`, `add column if not exists`, guarded backfill).
- RLS on `tax_authorities` + `tax_entity_profile` follows the service-role-only finance pattern (copy the `"finance readers"` policy block verbatim from `20260711_tax_module.sql:94-107`).
- Seed `tax_authorities`: `('nc_dor','NC Department of Revenue','both',0)`, `('federal_ttb','Alcohol and Tobacco Tax and Trade Bureau','excise',1)` via `on conflict (key) do nothing`.
- Backfill `excise_tax_rates.party_key` from legacy `receiving_party` text: map `ilike '%NC%'` / `'%North Carolina%'` / `'%DOR%'` → `'nc_dor'`; `ilike '%TTB%'` / `'%federal%'` / `'%alcohol and tobacco%'` → `'federal_ttb'`; leave others null (documented — a follow-up cleans unmatched rows manually).
- Backfill identity out of `tax_filing_profiles`: for the row where `party_key = 'nc_dor_sales_use'` (if present), copy `values->>'fein'`, `values->>'ssn'`, `values->>'contact_name'`, `values->>'contact_email'`, `values->>'contact_phone'` into the singleton `tax_entity_profile` (insert `id=true` row); copy `values->>'account_id'` into `tax_authorities.registration_number` where `key='nc_dor'`; then strip those six keys from `tax_filing_profiles.values` (`values - 'fein' - 'ssn' - 'contact_name' - 'contact_email' - 'contact_phone' - 'account_id'`), leaving `general_sales_tax_id` intact.
- Column comments on each new column mirroring the existing migration style.

**Steps:**
- [ ] **Step 1:** Write `20260713_tax_settings_restructure.sql` with sections: (a) create `tax_authorities` + seed, (b) create `tax_entity_profile`, (c) `alter table excise_tax_rates add column if not exists party_key ...` + FK, (d) backfill party_key, (e) backfill identity → entity/authority + strip keys, (f) RLS policies + comments.
- [ ] **Step 2:** Validate SQL parses locally without touching prod. Run: `npx supabase db lint --file supabase/migrations/20260713_tax_settings_restructure.sql` if available; otherwise a `psql --dry-run`-equivalent parse check, else careful manual read. Expected: no syntax errors. **Do NOT apply to prod.**
- [ ] **Step 3:** Commit. `git add supabase/migrations/20260713_tax_settings_restructure.sql && git commit -m "feat(tax): migration — authorities spine, entity profile, excise party_key, slim profiles"`

**Note for orchestrator:** flag this migration for human apply (backup first). Existing prod-migration-authorization rule applies.

---

## Task 2: `lib/tax/entity.ts` — entity profile model + schema

**Files:**
- Create: `lib/tax/entity.ts`
- Test: `lib/tax/entity.test.ts`
- Modify: `lib/query-keys.ts` (add `tax.entityProfile()`)

**Interfaces:**
- Consumes: `maskSensitive` from `lib/tax/profiles.ts`, `FieldSpec` from `lib/tax/types.ts`, `SupabaseClient`.
- Produces:
  - `export const ENTITY_PROFILE_SCHEMA: FieldSpec[]` — fields: `legal_name` (text, required), `fein` (text — **NOT sensitive**, rendered as a normal editable text field per the FEIN-visible waiver), `ssn` (text, `sensitive: true`), `contact_name` (text), `contact_email` (email), `contact_phone` (tel), `address_line1` (text), `address_line2` (text), `city` (text), `state` (text), `postal_code` (text). Only `ssn` is masked (present/absent). See resolved Open Question O1.
  - `export type EntityProfileValues = Record<string, string>`
  - `export async function getEntityProfile(sb: SupabaseClient): Promise<EntityProfileValues>` — reads the singleton row (`.eq("id", true).maybeSingle()`), returns `{}` if absent, flattening columns into a `Record<string,string>` keyed by schema key.
  - `export async function putEntityProfile(sb: SupabaseClient, values: EntityProfileValues): Promise<void>` — blank = "leave unchanged" merge (same rule as `putProfile`), upsert on `id=true`.

**Acceptance criteria:**
- `getEntityProfile` maps DB columns ↔ schema keys 1:1 (columns are the schema keys, so a direct select works).
- `putEntityProfile` never wipes a stored sensitive value on a blank submit (mirror `lib/tax/profiles.ts:30-50`).
- `maskSensitive(values, ENTITY_PROFILE_SCHEMA)` masks `fein`/`ssn` to `present`/`absent`.

**Test cases (`entity.test.ts`, stub SupabaseClient like `profiles`/`schedules` tests):**
- `getEntityProfile` returns `{}` when no row.
- `getEntityProfile` returns column values keyed by schema key when a row exists.
- `putEntityProfile` merges: blank `ssn` submit keeps existing stored ssn; non-blank overwrites.
- `maskSensitive` on entity schema → `fein`/`ssn` become `present`/`absent`, `legal_name` passes through.

**Steps:**
- [ ] Step 1: Write `entity.test.ts` (failing).
- [ ] Step 2: Run `npx vitest run lib/tax/entity.test.ts` → FAIL (module missing).
- [ ] Step 3: Implement `lib/tax/entity.ts`; add `tax.entityProfile` to `lib/query-keys.ts`.
- [ ] Step 4: Run `npx vitest run lib/tax/entity.test.ts` → PASS.
- [ ] Step 5: Commit `feat(tax): entity profile model + schema`.

---

## Task 3: `lib/tax/authorities.ts` — receiving-party spine model

**Files:**
- Create: `lib/tax/authorities.ts`
- Test: `lib/tax/authorities.test.ts`
- Modify: `lib/query-keys.ts` (add `tax.authorities()`)

**Interfaces:**
- Produces:
  - `export interface TaxAuthority { key: string; label: string; kind: "filing" | "excise" | "both"; registration_number: string | null; display_order: number }`
  - `export async function listAuthorities(sb: SupabaseClient): Promise<TaxAuthority[]>` — `select(...).order("display_order")`.
  - `export async function updateRegistration(sb: SupabaseClient, key: string, registration_number: string | null): Promise<void>` — update the row; blank string → store null.

**Test cases:**
- `listAuthorities` returns rows ordered by `display_order`.
- `updateRegistration` writes null for empty string, value otherwise.
- `updateRegistration` on unknown key surfaces the DB error (throws).

**Steps:** TDD — test (fail) → implement → pass → commit `feat(tax): receiving-party authorities model`.

---

## Task 4: Entity-profile API route

**Files:**
- Create: `app/api/tax/entity-profile/route.ts`

**Interfaces:**
- Consumes: `getEntityProfile`/`putEntityProfile`/`ENTITY_PROFILE_SCHEMA` (Task 2), `maskSensitive`, `requireRole`, `createSupabaseAdminClient`, `apiError`.
- Produces: `GET /api/tax/entity-profile` → masked `Record<string,string>`; `PUT` → `{ ok: true }`.

**Acceptance criteria (mirror `app/api/tax/profiles/[party]/route.ts`):**
- `GET`: `requireRole(["manager"])`; returns `maskSensitive(await getEntityProfile(sb), ENTITY_PROFILE_SCHEMA)`.
- `PUT`: `requireRole([])` (admin-only); body `Record<string,string>`; `putEntityProfile(sb, body)`; returns `{ ok: true }`.
- `export const dynamic = "force-dynamic"`; errors via `apiError`.

**Acceptance test:** manual — `GET` returns `fein: "absent"`/`"present"` not the raw value.

**Steps:** implement → typecheck (`npx tsc --noEmit`) → commit `feat(tax): entity-profile API route`.

---

## Task 5: Authorities API route

**Files:**
- Create: `app/api/tax/authorities/route.ts`

**Interfaces:**
- `GET /api/tax/authorities` → `TaxAuthority[]` (`requireRole(["manager"])`).
- `PATCH /api/tax/authorities` → body `{ key: string; registration_number: string | null }`; `requireRole([])`; `updateRegistration(...)`; returns `{ ok: true }`.

**Acceptance criteria:** `dynamic = "force-dynamic"`; `apiError`; admin-gate the PATCH.

**Steps:** implement → typecheck → commit `feat(tax): authorities API route`.

---

## Task 6: Excise route — party filter + party_key writes

**Files:**
- Modify: `app/api/production/export-settings/excise-tax-rates/route.ts`
- Modify: `app/api/production/export-settings/excise-tax-rates/[id]/route.ts`

**Interfaces:**
- Consumes: existing `requireRole`, admin client.
- Produces: `GET ?party=<key>` optional filter; `party_key` accepted on POST body and PATCH body and returned in the select list.

**Acceptance criteria:**
- GET: add `party_key` to the `.select(...)` column list (both routes). If `req.nextUrl.searchParams.get("party")` is set, add `.eq("party_key", party)`.
- POST: accept optional `party_key` (string|null), insert it; keep existing `receiving_party` handling for back-compat.
- PATCH (`[id]`): allow `party_key` in the patch allowlist.
- No change to the export-invoice consumer contract (all existing columns still returned).

**Test cases:** the excise routes have no existing unit tests; add a light guard only if a test harness exists for routes — otherwise rely on typecheck + the UI acceptance in Task 9. Document that.

**Steps:** implement both files → `npx tsc --noEmit` → commit `feat(tax): excise rates route — party_key + party filter`.

---

## Task 7: Generalize `IdentityForm` to accept an endpoint

**Files:**
- Modify: `app/finance/settings/tax-filing/IdentityForm.tsx`

**Interfaces:**
- Change props from `{ partyKey: string; schema: FieldSpec[] }` to `{ schema: FieldSpec[]; endpoint: string; queryKey: readonly unknown[]; savedLabel?: string }`.
  - `endpoint` — the GET/PUT URL (e.g. `/api/tax/profiles/nc_dor_sales_use` or `/api/tax/entity-profile`).
  - `queryKey` — the TanStack key to read/invalidate.
- Preserve all current behavior (masked sensitive handling, Square-tax select population, blank=unchanged). The Square-taxes fetch stays keyed off `needsSquareTaxes` (schema-driven), so the entity profile — which has no `select` fields — simply won't fetch Square taxes.
- Existing caller in `tax-filing/page.tsx` is updated in Task 10 to pass `endpoint={`/api/tax/profiles/${party.templateKey}`}` and `queryKey={queryKeys.tax.profile(party.templateKey)}`.

**Acceptance criteria:** no behavioral regression for the party-profile use; component no longer hard-codes `/api/tax/profiles/${partyKey}`.

**Steps:** refactor → `npx tsc --noEmit` (will error at the old call site until Task 10; acceptable within the same group — or temporarily keep a back-compat overload). Prefer: update the one existing call site in the same commit to keep the tree green. Commit `refactor(tax): generalize IdentityForm to an endpoint prop`.

---

## Task 8: Tax Profile page + Registrations section + nav entry

**Files:**
- Create: `app/finance/settings/tax-profile/page.tsx`
- Create: `app/finance/settings/tax-profile/RegistrationsSection.tsx`
- Modify: `app/finance/settings/SettingsNav.tsx`

**Interfaces:**
- Consumes: generalized `IdentityForm` (Task 7), `ENTITY_PROFILE_SCHEMA`, `GET/PUT /api/tax/entity-profile`, `GET/PATCH /api/tax/authorities`, `queryKeys.tax.entityProfile()`/`authorities()`.

**Layout (`tax-profile/page.tsx`):**
- `<FinanceNav mobile />`, `<PageHeader title="Tax Profile" description="Filer identity and the account/license numbers registered with each tax authority." />`, `<SettingsNav />`.
- Section "Filer Identity": `<IdentityForm schema={ENTITY_PROFILE_SCHEMA} endpoint="/api/tax/entity-profile" queryKey={queryKeys.tax.entityProfile()} savedLabel="Tax profile saved." />`.
- Section "Registrations": `<RegistrationsSection />`.

**`RegistrationsSection.tsx`:**
- Fetches `GET /api/tax/authorities`; renders a `<Card>` with a small table: columns Authority (`label`), Kind (`<Badge>`), Registration / License # (editable `.inp-sm`, PATCH on blur when changed).
- Uses `<Banner>` for errors, token utilities only, `.inp-sm` inputs, `.btn-*` if a save button is used (prefer blur-commit like the excise rows).

**`SettingsNav.tsx`:** replace line 9 (`excise-tax`) and line 10 (`tax-filing`) with:
```tsx
{ href: "/finance/settings/tax-profile", label: "Tax Profile" },
{ href: "/finance/settings/tax-filing",  label: "Tax Filing"  },
```
(Excise Tax entry removed; order: after Counterparty Accounts, before Payroll.)

**Acceptance criteria:** page renders identity form (fein/ssn show "set/not set"), registrations table lists NC DOR + Federal TTB with editable numbers; nav shows Tax Profile + Tax Filing, no Excise Tax.

**Steps:** build page + section + nav → `npx tsc --noEmit` → commit `feat(tax): Tax Profile settings page + registrations`.

---

## Task 9: Relocate `ExciseRatesSection` (party-filtered, single source of truth)

**Files:**
- Create: `app/finance/settings/tax-filing/ExciseRatesSection.tsx`
- Modify: `app/production/components/ExportSettingsPanel.tsx` (import the relocated component; delete the local `ExciseTaxRateRow` + `ExciseTaxRatesSection` copies).

**Interfaces:**
- Produces: `export default function ExciseRatesSection({ partyKey }: { partyKey?: string })` — when `partyKey` is set, fetches `GET /api/production/export-settings/excise-tax-rates?party=${partyKey}` and sets `party_key` on created rows; when omitted (production export settings), fetches all (current behavior) and shows the Receiving Party column.
- Consumes: existing `useExciseTaxRatesQuery` (extend to accept an optional party arg, or add `useExciseTaxRatesQuery(party?)`), `useExportSquareCatalogQuery`, `SquareCatalogSelect`, `queryKeys.production.exciseTaxRates()`.

**Design notes:**
- Move `ExciseTaxRateRow` + `ExciseTaxRatesSection` bodies verbatim into the new file, renamed to `ExciseRatesSection`, adding the `partyKey` prop. When `partyKey` is provided, hide the free-text "Receiving Party" column (the party is fixed by context) and stamp `party_key` on POST.
- `ExportSettingsPanel.tsx` imports and renders `<ExciseRatesSection />` (no `partyKey`) wherever it currently renders the inline `<ExciseTaxRatesSection />`, preserving `scope` gating.
- Keep the query-key shared; if the finance view needs a party-scoped cache, key it `queryKeys.production.exciseTaxRates(partyKey)` (extend the key factory to take an optional arg).

**Acceptance criteria:** production Export Settings excise table is visually unchanged; the component is now imported from one place (no duplicated copy). Typecheck + `npm run verify` green.

**Steps:** extract → wire ExportSettingsPanel import → `npm run verify` → commit `refactor(tax): extract party-aware ExciseRatesSection`.

---

## Task 10: Restructure Tax Filing page + retire Excise subtab

**Files:**
- Modify: `app/finance/settings/tax-filing/page.tsx`
- Modify: `app/finance/settings/excise-tax/page.tsx` (redirect stub)
- (SettingsNav already updated in Task 8.)

**Interfaces:**
- Consumes: `GET /api/tax/authorities` (drives the per-authority picker), the worksheet party registry (`useTaxPartiesQuery` for `settingsSchema`/`referenceView`), generalized `IdentityForm` (Task 7), `ExciseRatesSection` (Task 9).
- Authority → worksheet-template mapping: `nc_dor` → `nc_dor_sales_use` (has settingsSchema + referenceView); `federal_ttb` → none (excise-only). Keep the map inline in the page (small, explicit): `const TEMPLATE_BY_AUTHORITY: Record<string,string> = { nc_dor: "nc_dor_sales_use" }`.

**Layout (`tax-filing/page.tsx`):**
- `<PageHeader title="Tax Filing" description="Per-authority Square mappings, excise rates, and the statutory tables the worksheet relies on." />`.
- Authority picker: select over `tax_authorities` (default first). For the selected authority:
  - If it maps to a worksheet template with a non-empty `settingsSchema`: Section "Square Mappings" → `<IdentityForm schema={template.settingsSchema} endpoint={`/api/tax/profiles/${templateKey}`} queryKey={queryKeys.tax.profile(templateKey)} />`.
  - Section "Excise Rates" → `<ExciseRatesSection partyKey={authority.key} />` (shown for authorities whose `kind` is `excise` or `both`).
  - If template present: Section "Reference Data" → `<ReferenceDisclosure referenceView={template.referenceView} />`.
  - Section "Schedules": a short line + link to `/finance/tax` (where schedules/worksheets live) — not re-implemented here.
- **Remove** the "Filing Identity" section (`IDENTITY_SCHEMA` block) entirely — it now lives in Tax Profile.

**`excise-tax/page.tsx` redirect stub:**
```tsx
import { redirect } from "next/navigation";
export default function ExciseTaxSettingsRedirect() {
  redirect("/finance/settings/tax-filing");
}
```
(Confirm redirect import path against `docs/nextjs16-deltas.md` before writing — Extended Documentation Trigger for routing uncertainty.)

**Acceptance criteria:**
- Tax Filing page shows an authority picker; NC DOR shows Square Mappings + Excise Rates + Reference + Schedules link; Federal TTB shows Excise Rates only. No filing-identity fields on this page.
- Visiting `/finance/settings/excise-tax` redirects to Tax Filing.
- `npm run verify` green; browser spot-check on the dev server (per repo verification workflow): both subtabs render, save round-trips (entity profile masked, registration PATCH, excise CRUD scoped to party).

**Steps:** restructure page → add redirect stub → `npm run verify` → browser verify → commit `feat(tax): per-authority Tax Filing page; retire Excise subtab`.

---

## Open Questions (resolve before/at execution)

- **O1 — FEIN masking: RESOLVED (2026-07-13).** Keep the FEIN-visible waiver — `ssn` is `sensitive` (masked present/absent), `fein` is a normal visible text field. `ENTITY_PROFILE_SCHEMA` reflects this.
- **O2 — Unmatched excise `receiving_party`:** rows whose free-text party doesn't map to `nc_dor`/`federal_ttb` get `party_key = null` and won't appear under any authority's Excise Rates. Task 1 documents this; a manual cleanup (or a new authority row) is a post-apply follow-up.
- **O3 — Drop `receiving_party` column:** kept for now (export invoicing may read it). Dropping it is a follow-up once the export path reads `party_key` + the authority label.

## Self-Review

- **Spec coverage:** Issue 1 (unify) → Tasks 1, 6, 9, 10 (excise gains a party FK and moves under the per-authority Tax Filing page; Excise subtab retired). Issue 2 (separate general vs schedule-specific) → Tasks 1, 2, 4, 8 (entity profile + registrations split out) and Task 10 (identity section removed from Tax Filing). ✎ Covered.
- **Type consistency:** `TaxAuthority` (Task 3) used by Tasks 5/8/10; `ENTITY_PROFILE_SCHEMA` (Task 2) used by Tasks 4/8; generalized `IdentityForm` prop shape (Task 7) consumed by Tasks 8/10; `ExciseRatesSection({partyKey?})` (Task 9) consumed by Task 10 and ExportSettingsPanel. Party-key vocabulary: authority keys `nc_dor`/`federal_ttb` vs worksheet template key `nc_dor_sales_use` — mapping centralized in Task 10.
- **Placeholder scan:** no TBD/"handle edge cases"; inline code kept to small non-obvious snippets (redirect stub, nav entries, mapping const) per repo token-discipline.
