# Tax Profile v2: Legal Representative + Required Registrations — Design

## Context

[PR #191](https://github.com/terrier-point-brewing/terrier-point-brewing/pull/191) (not yet merged) simplified the NC DOR Beer Excise (B-C-710) worksheet and, as part of that, added a "Filing Identity" header sourced from `tax_entity_profile` (business identity: legal name, trade name, address, contact, `fax_number`, `state_of_domicile`) and an ad hoc per-party `HEADER_REGISTRATION_AUTHORITIES` map in `TaxWorksheetShell.tsx` that finds FEIN/NCDOR-ID/ABC-permit by "first `tax_registrations` row for this authority."

A second, independent design (from another agent, working from a stale view of the codebase — it believed migration `20260728` was still unapplied, which it is not) proposed a `tax_registrations.key` column + a `TaxPartyTemplate.requiredRegistrations` mechanism to replace that fragile "first row wins" lookup, plus a Tax Profile settings-page split into "Required for active filings" vs. "Other registrations."

Comparing the two surfaced a real product question that neither design had actually answered correctly: **what *is* "State of Domicile"?** PR #191 modeled it as an independent field on the business entity. The other design dropped it, deriving it from the entity's mailing-address state. Neither is right — brainstorming with the user surfaced that "State of Domicile," on this form, is a property of **whoever signs the filing** (the legal representative), not the business, and that the business's contact fields (`contact_name`, `contact_email`, `ssn`) were never really business attributes either — they're a person's. This spec formalizes that split and reconciles both prior designs into one coherent, mergeable change.

**Depends on:** PR #191 having merged first (this migration runs after `20260729_beer_excise_header_fields.sql` and partially reverses one piece of it — see Data Model).

## Goal

Split "the business" from "the person who signs for it" in Tax Profile, replace the fragile authority-based registration lookup with a stable, deterministic one, and wire both into the worksheet header and the Tax Profile settings pages — for both current parties (`nc_dor_beer_excise`, `nc_dor_sales_use`), not just beer excise.

## Data Model

### `tax_entity_profile` (business identity only)

Drops: `ssn`, `contact_name`, `contact_email`, `state_of_domicile` (the last of these was added by PR #191's `20260729` migration — this design reverses that one piece; "State of Domicile" is never stored here).

Keeps: `legal_name`, `trade_name`, `address_line1`, `address_line2`, `city`, `state`, `postal_code`, `contact_phone` (relabeled "Phone number" in `ENTITY_PROFILE_SCHEMA` — it's the business's general phone now, not a specific person's), `fax_number`.

### `tax_legal_representative` (new, singleton — same pattern as `tax_entity_profile`)

```sql
create table public.tax_legal_representative (
  id            boolean     primary key default true check (id),
  name          text,
  title         text,
  phone         text,
  email         text,
  ssn           text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  updated_at    timestamptz not null default now()
);
```

Same RLS policy shape as `tax_entity_profile` ("finance readers", `get_my_role() = any(finance_reader_roles())`). `ssn` is `sensitive` in its `FieldSpec` (masked to `"present"`/`"absent"` on GET, same convention as `tax_entity_profile.ssn` today). **"State of Domicile" is never a column anywhere** — it is this row's `state`, read directly wherever it's displayed. No derivation function needed; the consuming code just reads `.state` and labels that row "State of Domicile."

### Migration (`supabase/migrations/20260730_tax_profile_legal_representative_and_registration_keys.sql`)

Ordered, idempotent where possible (`create table if not exists`, `add column if not exists`); the backfill/drop steps are one-shot (matches the existing `20260728`/`20260713` migrations' documented pattern — human-gated, not auto-applied):

1. Create `tax_legal_representative`.
2. Backfill one row (`id = true`) from the current `tax_entity_profile`: `contact_name → name`, `contact_email → email`, `ssn → ssn`. Guarded with `on conflict (id) do nothing` (never overwrites if a row somehow already exists) and only runs if a `tax_entity_profile` row exists.
3. Drop `tax_entity_profile.ssn`, `.contact_name`, `.contact_email`, `.state_of_domicile`.
4. Add `tax_registrations.key text` (nullable) + partial unique index `create unique index tax_registrations_authority_key_key_idx on tax_registrations(authority_key, key) where key is not null`.
5. Backfill keys, each guarded to fire only when exactly one unkeyed row matches (mirrors the cautious pattern in `20260728`'s backfill steps — never collapses/misassigns if the assumption doesn't hold):
   - The existing `nc_dor` "Account / License #" row → `key = 'nc_dor_account_id'` (named for the shared authority, not "sales_use" — both `nc_dor_sales_use` and `nc_dor_beer_excise` depend on this same row going forward).
   - The existing `irs` FEIN row → `key = 'fein'`.
   - No backfill for `nc_abc` (no row exists yet — created later through the new "Required for active filings" UI).
6. RLS + column comments for the new table, matching the existing house style.

## Required Registrations Mechanism

**Type** (`lib/tax/types.ts`, alongside `TaxPartyTemplate`):
```ts
export interface RequiredRegistration { authorityKey: string; registrationKey: string; label: string }
```

**`TaxPartyTemplate` gains** `requiredRegistrations: RequiredRegistration[]`:
- `nc_dor_sales_use`: `[{ authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" }]`
- `nc_dor_beer_excise`: `[{ authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" }, { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number" }]`

**`BASE_REQUIRED_REGISTRATIONS`** (new export, `lib/tax/registrations.ts`): `[{ authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" }]`. Every party gets this without declaring it.

**`resolveRequiredRegistrations(template, registrations)`** (new pure function, `lib/tax/registrations.ts`): given a party's `requiredRegistrations` and the full `TaxRegistration[]` list, returns `BASE_REQUIRED_REGISTRATIONS` + the party's own list (deduped by `authorityKey:registrationKey`), each entry resolved to `{ authorityKey, registrationKey, label, number: string | null }` by matching `(authority_key, key)` — not "first row for this authority." This single function is the one place both the worksheet header (Section: Worksheet Header) and the settings page's "Required for active filings" block (Section: Settings UI) call — no duplicate resolution logic between the two surfaces.

**`listActivePartyKeys(sb)`** (new, `lib/tax/schedules.ts`) — thin wrapper, not a new query:
```ts
export async function listActivePartyKeys(sb: SupabaseClient): Promise<string[]> {
  const schedules = await listSchedules(sb, { activeOnly: true });
  return [...new Set(schedules.map((s) => s.party_key))];
}
```

**`GET /api/tax/parties`** resolves each party's complete required list server-side (via `resolveRequiredRegistrations`) and includes it in the response; `TaxPartyMeta` (`app/finance/tax/hooks/useTaxData.ts`) gains a `requiredRegistrations: ResolvedRequiredRegistration[]` field. The client never merges `BASE_REQUIRED_REGISTRATIONS` itself.

**`GET /api/tax/registrations`** gains a `required: ResolvedRequiredRegistration[]` field — `BASE_REQUIRED_REGISTRATIONS` plus every *active-schedule* party's `requiredRegistrations` (via `listActivePartyKeys` + `resolveRequiredRegistrations`), deduped the same way. This scoping (active schedules only) is deliberately narrower than the worksheet-header case (which is always for one specific, already-known party) — it's what makes the settings page's "Required" block show only what's actually relevant right now, not every requirement any party template has ever declared.

## API Surface

- New: `GET`/`PUT /api/tax/legal-representative` (mirrors `/api/tax/entity-profile` exactly: `requireRole(["manager"])` on GET, `requireRole([])` on PUT, masks `ssn` via the existing `maskSensitive`, same blank-means-unchanged merge convention via a new `lib/tax/legalRepresentative.ts` module mirroring `lib/tax/entity.ts`).
- `GET /api/tax/entity-profile`: `ENTITY_PROFILE_SCHEMA` drops the `ssn`/`contact_name`/`contact_email`/`state_of_domicile` `FieldSpec` entries; `contact_phone`'s label changes to "Phone number".
- `GET /api/tax/parties`: adds `requiredRegistrations` (see above).
- `GET /api/tax/registrations`: adds `required` (see above); the existing flat list response (all rows, all authorities) is unchanged — this is additive.

## Settings UI

**Tax Profile page** (`app/finance/settings/tax-profile/page.tsx`) gains a new "Legal Representative" section directly below "Filer Identity", using the existing generic `IdentityForm` unchanged — same component, new `schema`/`endpoint`/`queryKey` props, exactly like the existing "Filer Identity" section. Zero new form-rendering code.

**`RegistrationsSection.tsx`** splits into two blocks:
- **Required for active filings** — one row per entry in the resolved `required` list from `GET /api/tax/registrations`: label locked (from the resolved entry, not user-editable), only the number is an editable `<input>`, pre-filled from `number` when present. Saving writes a row with that `(authority_key, key)` pair — if no row exists yet (e.g. the ABC permit today), a fresh keyed row is created on save.
- **Other registrations** — today's freeform per-authority editor, unchanged, minus any row whose `(authority_key, key)` already appears in the "Required" block above (so nothing is editable in two places at once).

Both blocks still flatten into one `PUT /api/tax/registrations` call on Save — the existing full-reconcile-on-save contract (`saveRegistrations`) is unchanged; this is a rendering/grouping change, not an API contract change.

## Worksheet Header

`TaxWorksheetShell.tsx` deletes the `HEADER_REGISTRATION_AUTHORITIES` map entirely. `IdentityHeader`'s row composition becomes, in order:

1. **Registration rows** — `party.requiredRegistrations` (already fully resolved by the server, per-party — no client-side merge, no authority-only fuzzy matching).
2. **Entity rows** — Legal Entity Name (`legal_name`), Trade Name (`trade_name`), Address (`address_line1/2` + `city`/`state`/`postal_code`, same `formatEntityAddress` helper as today).
3. **Representative rows** — Name of Contact Person (representative's `name`), State of Domicile (representative's `state` — read directly, not a separate field).
4. **Entity rows again** — Phone Number (`contact_phone`), Fax Number (`fax_number`) — business-level, per the user's explicit call.
5. **Schema rows** — unchanged, still last, still empty for both current parties.

The representative's `title`, `ssn`, and own street address are captured in Tax Profile but **not** rendered on this header — the B-C-710 header only asks for what's listed above; nothing else is added speculatively.

`IdentityHeader` gains one new data source (`representative?: Record<string, string>`, from a new `useLegalRepresentativeQuery()` hook in `useTaxData.ts`, same pattern as `useEntityProfileQuery()`/`useRegistrationsQuery()`) and drops the `registrationAuthorities` prop (no longer needed — `schema`/`values`/`entity`/`registrations`/`representative`/`isLoading` remain, `registrations` is now pre-filtered/resolved via `party.requiredRegistrations` rather than raw + a client-side authority map).

## Out of Scope (explicitly, per YAGNI)

- No UI for the representative's `title`/street address on any worksheet header (stored, not displayed there).
- No support for multiple representatives, or a different representative per party/filing — confirmed single-person, singleton.
- No change to `saveRegistrations`' full-reconcile-on-save contract, or to `tax_authorities`.
- No change to how `nc_dor_sales_use`'s own `settingsSchema` fields (Square mappings) work — they remain, rendered last, unaffected by any of the above.

## Self-Review

- **Placeholders:** none — every field, key name, and migration step above is concrete.
- **Internal consistency:** the "State of Domicile" resolution (representative's `state`, no stored column) is applied consistently in both the Data Model and Worksheet Header sections; the registration-key naming (`nc_dor_account_id`, not `sales_use_account_id`) is applied consistently in both the Data Model and Required Registrations sections.
- **Scope:** single cohesive change (one migration, one consuming header) — not decomposed further, since Legal-Representative and Required-Registrations both feed the same `IdentityHeader` consumer and were asked for together as one follow-up PR.
- **Ambiguity check:** "Phone Number"/"Fax Number stay business-level" and "Title/SSN/rep address not shown on the header" are both stated explicitly to close off the two ambiguous readings that came up during the Q&A.
