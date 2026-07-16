# Tax Profile v2: Legal Representative + Required Registrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split "the business" from "the person who signs for it" in Tax Profile (a new `tax_legal_representative` singleton table), replace the fragile "first `tax_registrations` row for this authority" lookup with a deterministic `(authority_key, key)` mechanism declared per party template, and wire both into the worksheet's Filing Identity header and the Tax Profile settings pages.

**Architecture:** Five independent locality groups, each touching a disjoint file set (only Task 3's API-shape change is a hard prerequisite for Tasks 4–5 consuming it, which is satisfied by running the tasks in order):
- **Task 1** — Legal Representative data model: new table + lib module + API route, `tax_entity_profile` trimmed to business-only fields.
- **Task 2** — Registrations gain a stable `key` column; a `requiredRegistrations` resolution mechanism is built as pure, independently-testable functions.
- **Task 3** — Both party templates declare their required registrations; `GET /api/tax/parties` and `GET /api/tax/registrations` resolve and expose them.
- **Task 4** — Tax Profile settings UI: a new "Legal Representative" section, and `RegistrationsSection` splits into "Required for active filings" / "Other registrations".
- **Task 5** — `TaxWorksheetShell`'s `IdentityHeader` consumes everything: the ad hoc per-party map it currently uses is deleted.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Vitest, Tailwind v4 token utilities.

**Depends on:** PR #191 (merged, commit `169b084`) — this plan's migrations run after `20260729_beer_excise_header_fields.sql` and partially reverse one piece of it (`tax_entity_profile.state_of_domicile`, added there, dropped here — see Task 1).

**Spec:** `docs/superpowers/specs/2026-07-15-tax-profile-legal-representative-design.md` — read it once for the "why" behind the field placements (State of Domicile = the representative's `state`, not a stored column; Phone/Fax stay business-level) if a task's rationale is unclear. Each task below is self-contained and doesn't require reading the spec to execute.

## Global Constraints

- No raw Tailwind color utilities (`zinc-*`/`amber-*`/`red-*`/`green-*`/`blue-*`/`gray-*`) or hex/rgb literals — only existing token classes (`text-body`, `text-strong`, `text-faint`, `border-line`, etc.).
- Migrations are **human-gated** — write the `.sql` files, never apply them (no `execute_sql`/`apply_migration` calls against the live project).
- Every `lib/` change ships with co-located `*.test.ts` updates/additions; do not drop vitest coverage below the floor in `vitest.config.ts` (lines/statements ≥ 86%).
- This repo has no `*.test.tsx` component tests (`vitest.config.ts` only includes `lib/**/*.test.ts` and `app/**/*.test.ts`) — `.tsx` changes are verified by `npx tsc --noEmit`, not new test files.
- `saveRegistrations`' full-reconcile-on-save contract (`PUT /api/tax/registrations` fully replaces the row set) does not change — only how the UI groups/labels rows before submitting them.
- The representative's `title`, `ssn`, and street address are captured in Tax Profile but must **not** appear on the worksheet header — only `name` and the derived `state` (labeled "State of Domicile") do.

---

## Task 1: Legal Representative data model

**Files:**
- Create: `supabase/migrations/20260730_tax_legal_representative.sql`
- Create: `lib/tax/legalRepresentative.ts`
- Create: `lib/tax/legalRepresentative.test.ts`
- Create: `app/api/tax/legal-representative/route.ts`
- Modify: `lib/tax/entity.ts`
- Modify: `lib/tax/entity.test.ts`
- Modify: `lib/tax/usStates.ts:1-3`
- Modify: `lib/query-keys.ts:120-133`

**Interfaces:**
- Consumes: `FieldSpec` (`lib/tax/types.ts`, unchanged), `maskSensitive` (`lib/tax/profiles.ts`, unchanged — generic over any `FieldSpec[]`).
- Produces: `LEGAL_REPRESENTATIVE_SCHEMA: FieldSpec[]`, `getLegalRepresentative(sb): Promise<Record<string,string>>`, `putLegalRepresentative(sb, values): Promise<void>` (all from the new `lib/tax/legalRepresentative.ts`, mirroring `lib/tax/entity.ts`'s exports exactly) — Task 4 imports `LEGAL_REPRESENTATIVE_SCHEMA` for the new settings-page section; Task 5 reads the representative's `name`/`state` via a new client hook that calls `GET /api/tax/legal-representative`. `ENTITY_PROFILE_SCHEMA` loses the `ssn`/`contact_name`/`contact_email`/`state_of_domicile` keys — no other task reads those keys off it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260730_tax_legal_representative.sql`:

```sql
-- Tax Profile: Legal Representative
--
-- Splits "the person who signs for the business" out of tax_entity_profile
-- (which stays business-identity-only: legal name, trade name, address,
-- general phone/fax) into its own singleton table, same pattern as
-- tax_entity_profile itself (id boolean primary key default true).
--
-- "State of Domicile" is deliberately NOT a column here or anywhere — it's
-- this row's `state`, read directly wherever it needs to be displayed (see
-- app/finance/tax/[taskId]/TaxWorksheetShell.tsx's IdentityHeader). The
-- `state_of_domicile` column tax_entity_profile gained in migration
-- 20260729_beer_excise_header_fields.sql is dropped below — it never had
-- real data (no worksheet consumed it yet), so no backfill is needed for it.
--
-- Human-gated (do not auto-apply).

-- ── 1. tax_legal_representative (singleton) ───────────────────────────────────

create table if not exists public.tax_legal_representative (
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

alter table public.tax_legal_representative enable row level security;
create policy "finance readers" on public.tax_legal_representative
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

comment on column public.tax_legal_representative.id is 'singleton guard: boolean PK fixed true so only one row can exist';
comment on column public.tax_legal_representative.ssn is 'treated as sensitive in the app layer, same convention as the legacy tax_entity_profile.ssn';
comment on table public.tax_legal_representative is 'the individual who signs/certifies filings on behalf of the business — distinct from tax_entity_profile (the business itself)';

-- ── 2. Backfill from the existing tax_entity_profile row ──────────────────────
-- Safe no-op when no tax_entity_profile row exists yet; never clobbers a
-- pre-existing tax_legal_representative row (on conflict do nothing).

insert into public.tax_legal_representative (id, name, email, ssn)
select true, e.contact_name, e.contact_email, e.ssn
from public.tax_entity_profile e
where e.id = true
on conflict (id) do nothing;

-- ── 3. Drop the columns that moved off tax_entity_profile ─────────────────────

alter table public.tax_entity_profile drop column if exists ssn;
alter table public.tax_entity_profile drop column if exists contact_name;
alter table public.tax_entity_profile drop column if exists contact_email;
alter table public.tax_entity_profile drop column if exists state_of_domicile;

comment on column public.tax_entity_profile.contact_phone is 'business-level phone number (not tied to a specific person — see tax_legal_representative.phone for the signer''s own number)';
```

- [ ] **Step 2: Write `lib/tax/legalRepresentative.ts`**

```ts
/**
 * Singleton legal representative storage (`tax_legal_representative`) — the
 * individual who signs/certifies filings on behalf of the business, distinct
 * from `tax_entity_profile` (the business itself — see lib/tax/entity.ts).
 * Same singleton (`id = true`) and blank-means-leave-unchanged merge
 * convention as `tax_entity_profile` — the UI never round-trips the real
 * value for the `sensitive` SSN field, so a blank submitted value must not
 * wipe the stored one.
 *
 * "State of Domicile" is never a column here — callers read this record's
 * `state` directly and label it "State of Domicile" wherever needed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";
import { US_STATES } from "./usStates";

export const LEGAL_REPRESENTATIVE_SCHEMA: FieldSpec[] = [
  { key: "name", label: "Full name", type: "text", required: true },
  { key: "title", label: "Title", type: "text" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "email", label: "Email", type: "email" },
  { key: "ssn", label: "SSN (only if no FEIN on file)", type: "text", sensitive: true },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "select", options: US_STATES },
  { key: "postal_code", label: "Postal code", type: "text" },
];

export type LegalRepresentativeValues = Record<string, string>;

export async function getLegalRepresentative(sb: SupabaseClient): Promise<LegalRepresentativeValues> {
  const { data, error } = await sb.from("tax_legal_representative").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return {};

  const row = data as Record<string, unknown>;
  const values: LegalRepresentativeValues = {};
  for (const field of LEGAL_REPRESENTATIVE_SCHEMA) {
    const value = row[field.key];
    if (value != null) values[field.key] = String(value);
  }
  return values;
}

export async function putLegalRepresentative(sb: SupabaseClient, values: LegalRepresentativeValues): Promise<void> {
  const existing = await getLegalRepresentative(sb);
  const merged: LegalRepresentativeValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    // Blank = "leave unchanged" so a masked SSN round-trip can't wipe it.
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_legal_representative")
    .upsert({ id: true, ...merged, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 3: Write `lib/tax/legalRepresentative.test.ts`** (mirrors `lib/tax/entity.test.ts` exactly, adapted to the new table/schema)

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getLegalRepresentative,
  putLegalRepresentative,
  LEGAL_REPRESENTATIVE_SCHEMA,
  type LegalRepresentativeValues,
} from "./legalRepresentative";
import { maskSensitive } from "./profiles";

type Recorded = { table: string; op: string; payload?: unknown; opts?: unknown };

function makeClient(row: Record<string, unknown> | null, upsertError?: string) {
  const recorded: Recorded[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: row, error: null });
      b.upsert = (payload: unknown, opts: unknown) => {
        recorded.push({ table, op: "upsert", payload, opts });
        return Promise.resolve({ error: upsertError ? { message: upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("getLegalRepresentative", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getLegalRepresentative(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string", async () => {
    const { client } = makeClient({
      id: true,
      name: "Weining Liao",
      title: null,
      phone: null,
      email: null,
      ssn: null,
      address_line1: null,
      address_line2: null,
      city: null,
      state: "NC",
      postal_code: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getLegalRepresentative(client);
    expect(result).toEqual({ name: "Weining Liao", state: "NC" });
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;
    await expect(getLegalRepresentative(client)).rejects.toThrow(/boom/);
  });
});

describe("putLegalRepresentative", () => {
  it("preserves an existing sensitive value when the submitted value is blank, and upserts on id", async () => {
    const { client, recorded } = makeClient({ id: true, ssn: "999", updated_at: "2026-01-01T00:00:00Z" });
    await putLegalRepresentative(client, { ssn: "", name: "New Name" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_legal_representative");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      ssn: "999",
      name: "New Name",
      updated_at: expect.any(String),
    });
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putLegalRepresentative(client, { name: "New" })).rejects.toThrow(/constraint violation/);
  });
});

describe("maskSensitive on LEGAL_REPRESENTATIVE_SCHEMA", () => {
  it("masks ssn as present/absent and passes through non-schema fields unchanged", () => {
    const values: LegalRepresentativeValues = { ssn: "999", name: "X" };
    const result = maskSensitive(values, LEGAL_REPRESENTATIVE_SCHEMA);
    expect(result.ssn).toBe("present");
    expect(result.name).toBe("X");
  });
});
```

- [ ] **Step 4: Write `app/api/tax/legal-representative/route.ts`** (mirrors `app/api/tax/entity-profile/route.ts` exactly)

```ts
/**
 * Singleton legal representative (`tax_legal_representative`) — the
 * individual who signs/certifies filings on behalf of the business, distinct
 * from the entity itself (see lib/tax/legalRepresentative.ts).
 *
 * GET returns the record with `sensitive` schema fields masked to
 * `"present"`/`"absent"` — the SSN never leaves the server. PUT is
 * admin-only and merges submitted values onto the stored record (blank =
 * leave unchanged).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  getLegalRepresentative,
  putLegalRepresentative,
  LEGAL_REPRESENTATIVE_SCHEMA,
} from "@/lib/tax/legalRepresentative";
import { maskSensitive } from "@/lib/tax/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const values = await getLegalRepresentative(sb);
    return NextResponse.json(maskSensitive(values, LEGAL_REPRESENTATIVE_SCHEMA));
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Record<string, string>;
    const sb = createSupabaseAdminClient();
    await putLegalRepresentative(sb, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
```

- [ ] **Step 5: Trim `lib/tax/entity.ts`** to business-only fields

Replace the full file contents with:

```ts
/**
 * Singleton tax entity profile storage (`tax_entity_profile`) — the
 * brewery's own business identity (legal name, trade name, mailing address,
 * general phone/fax) used to prefill filings across every receiving party.
 * The person who signs filings on the business's behalf is a SEPARATE
 * singleton, `tax_legal_representative` (lib/tax/legalRepresentative.ts) —
 * this table is business-only. Unlike `tax_filing_profiles` (per-party,
 * `lib/tax/profiles.ts`), this is a single row identified by `id = true`,
 * with schema keys mapped 1:1 onto columns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";

export const ENTITY_PROFILE_SCHEMA: FieldSpec[] = [
  { key: "legal_name", label: "Legal entity name", type: "text", required: true },
  { key: "trade_name", label: "Trade name (DBA)", type: "text" },
  { key: "contact_phone", label: "Phone number", type: "tel" },
  { key: "fax_number", label: "Fax number", type: "tel" },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postal_code", label: "Postal code", type: "text" },
];

export type EntityProfileValues = Record<string, string>;

export async function getEntityProfile(sb: SupabaseClient): Promise<EntityProfileValues> {
  const { data, error } = await sb.from("tax_entity_profile").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return {};

  const row = data as Record<string, unknown>;
  const values: EntityProfileValues = {};
  for (const field of ENTITY_PROFILE_SCHEMA) {
    const value = row[field.key];
    if (value != null) values[field.key] = String(value);
  }
  return values;
}

export async function putEntityProfile(sb: SupabaseClient, values: EntityProfileValues): Promise<void> {
  const existing = await getEntityProfile(sb);
  const merged: EntityProfileValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_entity_profile")
    .upsert({ id: true, ...merged, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}
```

(`US_STATES` import is gone — `state_of_domicile` no longer lives here; it moved to `lib/tax/legalRepresentative.ts`'s `state` field in Step 2. Blank-means-unchanged/upsert behavior is unchanged, just no longer has a `sensitive` field to guard, since `ssn` moved off this table entirely.)

Also update the now-stale comment in `lib/tax/usStates.ts` (its only remaining consumer is the new schema, not `state_of_domicile` on the entity). Change:

```ts
// Shared US-states option list (50 states + DC + PR), values as 2-letter
// codes. Used by any party's `select`-type FieldSpec that needs a state
// dropdown (e.g. NC DOR Beer Excise's `state_of_domicile`).
```

to:

```ts
// Shared US-states option list (50 states + DC + PR), values as 2-letter
// codes. Used by any party's `select`-type FieldSpec that needs a state
// dropdown (e.g. lib/tax/legalRepresentative.ts's `state` — the value
// surfaced on worksheet headers as "State of Domicile").
```

- [ ] **Step 6: Update `lib/tax/entity.test.ts`** — drop the fields that moved, drop the now-defunct `maskSensitive` block (entity has no sensitive field left), add an explicit "moved fields are gone" assertion

Replace the full file contents with:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEntityProfile, putEntityProfile, ENTITY_PROFILE_SCHEMA, type EntityProfileValues } from "./entity";

type Recorded = { table: string; op: string; payload?: unknown; opts?: unknown };

function makeClient(row: Record<string, unknown> | null, upsertError?: string) {
  const recorded: Recorded[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = () => Promise.resolve({ data: row, error: null });
      b.upsert = (payload: unknown, opts: unknown) => {
        recorded.push({ table, op: "upsert", payload, opts });
        return Promise.resolve({ error: upsertError ? { message: upsertError } : null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, recorded };
}

describe("ENTITY_PROFILE_SCHEMA", () => {
  it("no longer declares the fields that moved to tax_legal_representative, or the dropped state_of_domicile", () => {
    const keys = ENTITY_PROFILE_SCHEMA.map((f) => f.key);
    expect(keys).not.toContain("ssn");
    expect(keys).not.toContain("contact_name");
    expect(keys).not.toContain("contact_email");
    expect(keys).not.toContain("state_of_domicile");
  });
});

describe("getEntityProfile", () => {
  it("returns an empty object when no row exists yet", async () => {
    const { client } = makeClient(null);
    const result = await getEntityProfile(client);
    expect(result).toEqual({});
  });

  it("returns only non-null schema-key columns coerced to string, ignoring legacy/removed columns still present on the row", async () => {
    const { client } = makeClient({
      id: true,
      legal_name: "TPB LLC",
      fein: "12-345", // legacy column, never part of ENTITY_PROFILE_SCHEMA
      ssn: "999", // removed from schema (moved to tax_legal_representative) — must not be surfaced even if the column briefly still has data
      contact_name: "Old Contact",
      contact_email: "old@example.com",
      contact_phone: null,
      fax_number: null,
      address_line1: null,
      address_line2: null,
      city: null,
      state: null,
      postal_code: null,
      updated_at: "2026-01-01T00:00:00Z",
    });
    const result = await getEntityProfile(client);
    expect(result).toEqual({ legal_name: "TPB LLC" });
  });

  it("throws with the Supabase error message on query failure", async () => {
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () => Promise.resolve({ data: null, error: { message: "boom" } });
        return b;
      },
    } as unknown as SupabaseClient;
    await expect(getEntityProfile(client)).rejects.toThrow(/boom/);
  });
});

describe("putEntityProfile", () => {
  it("merges submitted values onto the existing row and upserts on id", async () => {
    const { client, recorded } = makeClient({ id: true, legal_name: "Old", updated_at: "2026-01-01T00:00:00Z" });
    await putEntityProfile(client, { legal_name: "New" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].table).toBe("tax_entity_profile");
    expect(recorded[0].opts).toEqual({ onConflict: "id" });
    expect(recorded[0].payload).toMatchObject({
      id: true,
      legal_name: "New",
      updated_at: expect.any(String),
    });
  });

  it("treats a blank submitted value as leave-unchanged", async () => {
    const { client, recorded } = makeClient({ id: true, trade_name: "Existing DBA", updated_at: "2026-01-01T00:00:00Z" });
    await putEntityProfile(client, { trade_name: "", legal_name: "New" });
    expect((recorded[0].payload as EntityProfileValues).trade_name).toBe("Existing DBA");
  });

  it("throws with the Supabase error message on upsert failure", async () => {
    const { client } = makeClient(null, "constraint violation");
    await expect(putEntityProfile(client, { legal_name: "New" })).rejects.toThrow(/constraint violation/);
  });
});
```

- [ ] **Step 7: Add the query key**

In `lib/query-keys.ts`, in the `tax:` block, add `legalRepresentative` right after `entityProfile`:

```ts
    entityProfile: () => ["tax", "entityProfile"] as const,
    legalRepresentative: () => ["tax", "legalRepresentative"] as const,
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run lib/tax/entity.test.ts lib/tax/legalRepresentative.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260730_tax_legal_representative.sql lib/tax/legalRepresentative.ts lib/tax/legalRepresentative.test.ts app/api/tax/legal-representative/route.ts lib/tax/entity.ts lib/tax/entity.test.ts lib/tax/usStates.ts lib/query-keys.ts
git commit -m "feat(tax): split Legal Representative out of Tax Profile into its own singleton"
```

---

## Task 2: Registrations `key` column + required-registrations resolution

**Files:**
- Create: `supabase/migrations/20260731_tax_registrations_keys.sql`
- Modify: `lib/tax/registrations.ts`
- Modify: `lib/tax/registrations.test.ts`
- Modify: `lib/tax/schedules.ts`
- Modify: `lib/tax/schedules.test.ts`
- Modify: `lib/tax/types.ts:58-73`

**Interfaces:**
- Consumes: `TaxSchedule`/`Frequency` (`lib/tax/types.ts`, unchanged), `listSchedules` (`lib/tax/schedules.ts`, unchanged signature, reused not reimplemented).
- Produces: `TaxRegistration`/`TaxRegistrationInput` gain `key: string | null`; new exports from `lib/tax/registrations.ts`: `RequiredRegistration` (`{ authorityKey: string; registrationKey: string; label: string }`), `ResolvedRequiredRegistration` (`{ authorityKey: string; registrationKey: string; label: string; id?: string; number: string | null }`), `BASE_REQUIRED_REGISTRATIONS: RequiredRegistration[]`, `resolveRequiredRegistrations(requirements: RequiredRegistration[], registrations: TaxRegistration[]): ResolvedRequiredRegistration[]`; new export from `lib/tax/schedules.ts`: `listActivePartyKeys(sb): Promise<string[]>`; `TaxPartyTemplate` (`lib/tax/types.ts`) gains `requiredRegistrations: RequiredRegistration[]`. Task 3 imports `RequiredRegistration`/`BASE_REQUIRED_REGISTRATIONS`/`resolveRequiredRegistrations`/`listActivePartyKeys` and declares `requiredRegistrations` on both party templates.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260731_tax_registrations_keys.sql`:

```sql
-- Tax Registrations: stable machine keys
--
-- Adds a nullable `key` column to tax_registrations so specific rows can be
-- found deterministically (by (authority_key, key)) instead of "whichever
-- row happens to be first for this authority" — which the worksheet header
-- (TaxWorksheetShell.tsx) was doing via an ad hoc hardcoded map. Existing
-- freeform rows keep key = null indefinitely; only rows a party template
-- explicitly requires (see lib/tax/registrations.ts's RequiredRegistration)
-- get one.
--
-- Backfill steps are guarded to fire ONLY when exactly one unkeyed row
-- matches the authority — mirrors the cautious pattern in migration
-- 20260728_tax_rates_and_registrations.sql's backfill steps. If the
-- assumption doesn't hold (0 or 2+ matching rows), the step is a no-op and
-- the row(s) are left for manual keying via the new "Required for active
-- filings" settings UI.
--
-- Human-gated (do not auto-apply).

alter table public.tax_registrations add column if not exists key text;

create unique index if not exists tax_registrations_authority_key_key_idx
  on public.tax_registrations (authority_key, key)
  where key is not null;

comment on column public.tax_registrations.key is 'stable machine key for a specific required registration (e.g. nc_dor_account_id, fein, abc_permit_number) — null for freeform/"Other" registrations';

-- Existing NC DOR account/license # row -> shared by every party filed with
-- NC DOR (both nc_dor_sales_use and nc_dor_beer_excise depend on this same
-- row going forward, hence the neutral "nc_dor_account_id" name, not
-- "sales_use"-specific).
update public.tax_registrations
set key = 'nc_dor_account_id'
where authority_key = 'nc_dor'
  and key is null
  and (select count(*) from public.tax_registrations where authority_key = 'nc_dor' and key is null) = 1;

-- Existing IRS FEIN row -> universal (BASE_REQUIRED_REGISTRATIONS, every party).
update public.tax_registrations
set key = 'fein'
where authority_key = 'irs'
  and key is null
  and (select count(*) from public.tax_registrations where authority_key = 'irs' and key is null) = 1;

-- No backfill for the ABC permit (nc_abc) — no row exists yet. It gets
-- created, already keyed 'abc_permit_number', the first time someone saves
-- it through the new "Required for active filings" settings UI.
```

- [ ] **Step 2: Write the failing tests** — add to `lib/tax/registrations.test.ts`

Add the new imports and test blocks. Change:

```ts
import {
  reconcileRegistrations,
  listRegistrations,
  saveRegistrations,
  type TaxRegistration,
  type TaxRegistrationInput,
} from "./registrations";

const sampleRegistrations: TaxRegistration[] = [
  { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0 },
  { id: "r2", authority_key: "nc_dor", label: "Account / License #", number: "NC-999", display_order: 0 },
];
```

to:

```ts
import {
  reconcileRegistrations,
  listRegistrations,
  saveRegistrations,
  resolveRequiredRegistrations,
  BASE_REQUIRED_REGISTRATIONS,
  type TaxRegistration,
  type TaxRegistrationInput,
  type RequiredRegistration,
} from "./registrations";

const sampleRegistrations: TaxRegistration[] = [
  { id: "r1", authority_key: "irs", label: "Federal EIN (FEIN)", number: "12-3456789", display_order: 0, key: "fein" },
  { id: "r2", authority_key: "nc_dor", label: "Account / License #", number: "NC-999", display_order: 0, key: "nc_dor_account_id" },
];
```

(The other `TaxRegistration[]`/`TaxRegistrationInput[]` literals later in this file — inside `saveRegistrations` describe blocks — don't need a `key` property added; it's optional-shaped as `key?: string | null` on the type, see Step 4, so existing freeform-row literals without it stay valid.)

Add this new describe block at the end of the file:

```ts
describe("BASE_REQUIRED_REGISTRATIONS", () => {
  it("is exactly the universal FEIN requirement", () => {
    expect(BASE_REQUIRED_REGISTRATIONS).toEqual([
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
    ]);
  });
});

describe("resolveRequiredRegistrations", () => {
  it("resolves a requirement to its matching (authority_key, key) row, including its id and number", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toEqual([
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)", id: "r1", number: "12-3456789" },
    ]);
  });

  it("resolves to number: null and no id when no matching row exists yet", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toEqual([
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number", id: undefined, number: null },
    ]);
  });

  it("matches by BOTH authority_key and key — a same-authority row with a different key must not match", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "nc_dor", registrationKey: "some_other_key", label: "Something Else" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result[0].number).toBeNull();
    expect(result[0].id).toBeUndefined();
  });

  it("dedupes requirements sharing the same (authorityKey, registrationKey), keeping the first occurrence's label", () => {
    const requirements: RequiredRegistration[] = [
      { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
      { authorityKey: "irs", registrationKey: "fein", label: "Duplicate Label" },
    ];
    const result = resolveRequiredRegistrations(requirements, sampleRegistrations);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Federal EIN (FEIN)");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/tax/registrations.test.ts`
Expected: FAIL — `resolveRequiredRegistrations`/`BASE_REQUIRED_REGISTRATIONS` are not exported yet.

- [ ] **Step 4: Implement in `lib/tax/registrations.ts`**

Change the `TaxRegistration`/`TaxRegistrationInput` interfaces and `listRegistrations`'s select. Change:

```ts
export interface TaxRegistration {
  id: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
}

export interface TaxRegistrationInput {
  id?: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
}
```

to:

```ts
export interface TaxRegistration {
  id: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
  key: string | null;
}

export interface TaxRegistrationInput {
  id?: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
  key?: string | null;
}
```

Change:

```ts
export async function listRegistrations(sb: SupabaseClient): Promise<TaxRegistration[]> {
  const { data, error } = await sb
    .from("tax_registrations")
    .select("id, authority_key, label, number, display_order")
    .order("authority_key")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data as TaxRegistration[] | null) ?? [];
}
```

to:

```ts
export async function listRegistrations(sb: SupabaseClient): Promise<TaxRegistration[]> {
  const { data, error } = await sb
    .from("tax_registrations")
    .select("id, authority_key, label, number, display_order, key")
    .order("authority_key")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data as TaxRegistration[] | null) ?? [];
}
```

Add at the end of the file:

```ts
/**
 * A registration a party template needs on its worksheet header/settings —
 * resolved by (authority_key, key), never "first row for this authority".
 */
export interface RequiredRegistration {
  authorityKey: string;
  registrationKey: string;
  label: string;
}

/** A `RequiredRegistration` resolved against the live `tax_registrations` rows. */
export interface ResolvedRequiredRegistration extends RequiredRegistration {
  id?: string;
  number: string | null;
}

/** Universal requirement every party gets without declaring it itself. */
export const BASE_REQUIRED_REGISTRATIONS: RequiredRegistration[] = [
  { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
];

/**
 * Resolves a list of requirements (already merged from `BASE_REQUIRED_REGISTRATIONS`
 * + a party's own `requiredRegistrations`, or from several parties' combined
 * lists) against the live `tax_registrations` rows. Dedupes by
 * `authorityKey:registrationKey` (first occurrence's label wins) so callers
 * can pass overlapping lists without pre-filtering.
 */
export function resolveRequiredRegistrations(
  requirements: RequiredRegistration[],
  registrations: TaxRegistration[],
): ResolvedRequiredRegistration[] {
  const seen = new Set<string>();
  const deduped: RequiredRegistration[] = [];
  for (const req of requirements) {
    const dedupeKey = `${req.authorityKey}:${req.registrationKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(req);
  }

  return deduped.map((req) => {
    const match = registrations.find(
      (r) => r.authority_key === req.authorityKey && r.key === req.registrationKey,
    );
    return { ...req, id: match?.id, number: match?.number ?? null };
  });
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run lib/tax/registrations.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing test for `listActivePartyKeys`** — add to `lib/tax/schedules.test.ts`

Add the import and this describe block at the end of the file:

```ts
import { listSchedules, createSchedule, updateSchedule, setScheduleActive, getSchedule, listActivePartyKeys } from "./schedules";
```

```ts
describe("listActivePartyKeys", () => {
  it("returns distinct party_key values from active schedules only", async () => {
    // listActivePartyKeys calls listSchedules(sb, { activeOnly: true }), which
    // issues .eq("active", true) — the stub simulates the DB already having
    // applied that filter, matching the existing stub convention in this file
    // (see "applies partyKey and activeOnly filters when provided" above).
    const activeRows: TaxSchedule[] = [
      { ...sampleSchedule, id: "s1", party_key: "nc_dor_beer_excise", active: true },
      { ...sampleSchedule, id: "s2", party_key: "nc_dor_beer_excise", active: true },
    ];
    const client = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.order = () => b;
        b.eq = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: activeRows, error: null });
        return b;
      },
    } as unknown as SupabaseClient;

    const result = await listActivePartyKeys(client);
    expect(result).toEqual(["nc_dor_beer_excise"]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run lib/tax/schedules.test.ts`
Expected: FAIL — `listActivePartyKeys` is not exported yet.

- [ ] **Step 8: Implement `listActivePartyKeys` in `lib/tax/schedules.ts`**

Add at the end of the file:

```ts
/** Distinct `party_key` values across every currently-active schedule — thin wrapper over `listSchedules`, not a new query. */
export async function listActivePartyKeys(sb: SupabaseClient): Promise<string[]> {
  const schedules = await listSchedules(sb, { activeOnly: true });
  return [...new Set(schedules.map((s) => s.party_key))];
}
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run lib/tax/schedules.test.ts`
Expected: PASS

- [ ] **Step 10: Add `requiredRegistrations` to `TaxPartyTemplate`**

In `lib/tax/types.ts`, add the import and the field. Change:

```ts
import type { DueRule } from "./dueDate";
```

to:

```ts
import type { DueRule } from "./dueDate";
import type { RequiredRegistration } from "./registrations";
```

Change:

```ts
export interface TaxPartyTemplate {
  key: string;
  label: string;
  supportedFrequencies: Frequency[];
  computePeriod(freq: Frequency, ref: Date): TaxPeriod;
  defaultDueRule(freq: Frequency): DueRule;
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;
  fieldOwnership: Record<string, FieldOwnership>;
  mergeWorksheet(current: WorksheetData, recomputed: WorksheetData, rateMap: Record<string, number>): WorksheetData;
  settingsSchema: FieldSpec[];         // profile-level editable fields
  scheduleConfigSchema: FieldSpec[];   // schedule.config editable fields (counties)
  /** Builds the read-only rate/reference tables from the canonical rateMap (`buildRateMap(await listTaxRates(sb))`). */
  buildReferenceView(rateMap: Record<string, number>): ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;          // registry key for the React worksheet
}
```

to:

```ts
export interface TaxPartyTemplate {
  key: string;
  label: string;
  supportedFrequencies: Frequency[];
  computePeriod(freq: Frequency, ref: Date): TaxPeriod;
  defaultDueRule(freq: Frequency): DueRule;
  computeWorksheet(ctx: ComputeContext): Promise<WorksheetData>;
  fieldOwnership: Record<string, FieldOwnership>;
  mergeWorksheet(current: WorksheetData, recomputed: WorksheetData, rateMap: Record<string, number>): WorksheetData;
  settingsSchema: FieldSpec[];         // profile-level editable fields
  scheduleConfigSchema: FieldSpec[];   // schedule.config editable fields (counties)
  /** Builds the read-only rate/reference tables from the canonical rateMap (`buildRateMap(await listTaxRates(sb))`). */
  buildReferenceView(rateMap: Record<string, number>): ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;          // registry key for the React worksheet
  /** This party's own required tax_registrations (beyond BASE_REQUIRED_REGISTRATIONS, which every party gets automatically). */
  requiredRegistrations: RequiredRegistration[];
}
```

- [ ] **Step 11: Typecheck** (both party templates don't declare `requiredRegistrations` yet — this is expected to fail here; Task 3 adds it. Confirm the failure is exactly that, not something else)

Run: `npx tsc --noEmit 2>&1 | grep -i requiredRegistrations`
Expected: two errors, one per template file (`ncDorBeerExcise/template.ts` and `ncDorSalesUse/template.ts`), each saying the object literal is missing the `requiredRegistrations` property. This is the correct, expected state at the end of this task — Task 3 resolves it.

- [ ] **Step 12: Commit**

```bash
git add supabase/migrations/20260731_tax_registrations_keys.sql lib/tax/registrations.ts lib/tax/registrations.test.ts lib/tax/schedules.ts lib/tax/schedules.test.ts lib/tax/types.ts
git commit -m "feat(tax): add tax_registrations.key + required-registrations resolution"
```

---

## Task 3: Party templates declare required registrations; API surface exposes them

**Files:**
- Modify: `lib/tax/parties/ncDorBeerExcise/template.ts`
- Modify: `lib/tax/parties/ncDorBeerExcise/template.test.ts`
- Modify: `lib/tax/parties/ncDorSalesUse/template.ts`
- Modify: `lib/tax/parties/ncDorSalesUse/template.test.ts`
- Modify: `app/api/tax/parties/route.ts`
- Modify: `app/api/tax/registrations/route.ts`
- Modify: `app/finance/tax/hooks/useTaxData.ts`

**Interfaces:**
- Consumes: `RequiredRegistration`, `BASE_REQUIRED_REGISTRATIONS`, `resolveRequiredRegistrations`, `ResolvedRequiredRegistration` (Task 2, `lib/tax/registrations.ts`); `listActivePartyKeys` (Task 2, `lib/tax/schedules.ts`); `listRegistrations` (existing, `lib/tax/registrations.ts`); `listParties`/`getParty` (existing, `lib/tax/registry.ts`).
- Produces: `GET /api/tax/parties` response gains `requiredRegistrations: ResolvedRequiredRegistration[]` per party (fully resolved, base + own, server-side). `GET /api/tax/registrations` response shape changes from a bare `TaxRegistration[]` to `{ registrations: TaxRegistration[]; required: ResolvedRequiredRegistration[] }` — Task 4 and Task 5 both consume this new shape. `TaxPartyMeta` (`useTaxData.ts`) gains `requiredRegistrations: ResolvedRequiredRegistration[]`. `useRegistrationsQuery()`'s return type changes to match the new route response shape. New export `useLegalRepresentativeQuery()` (mirrors `useEntityProfileQuery()`, hits `GET /api/tax/legal-representative` from Task 1).

- [ ] **Step 1: Beer excise template declares its required registrations**

In `lib/tax/parties/ncDorBeerExcise/template.ts`, add the import. Change:

```ts
import { TAX_RATE_KEYS } from "@/lib/tax/rates";
```

to:

```ts
import { TAX_RATE_KEYS } from "@/lib/tax/rates";
import type { RequiredRegistration } from "@/lib/tax/registrations";
```

Add, right before the `// ── Assembled template ──` section:

```ts
const requiredRegistrations: RequiredRegistration[] = [
  { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
  { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number" },
];
```

Add `requiredRegistrations,` to the assembled `ncDorBeerExciseTemplate` object (right after `scheduleConfigSchema,`):

```ts
export const ncDorBeerExciseTemplate: TaxPartyTemplate = {
  key: "nc_dor_beer_excise",
  label: "NC DOR — Beer Excise Tax (B-C-710)",
  supportedFrequencies: ["monthly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeBeerExciseWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from shipments",
  worksheetComponent: "nc_dor_beer_excise",
};
```

- [ ] **Step 2: Sales & Use template declares its required registrations**

In `lib/tax/parties/ncDorSalesUse/template.ts`, add the import. Change:

```ts
import { TAX_RATE_KEYS, ncLocalKey, ncTransitKey } from "@/lib/tax/rates";
```

to:

```ts
import { TAX_RATE_KEYS, ncLocalKey, ncTransitKey } from "@/lib/tax/rates";
import type { RequiredRegistration } from "@/lib/tax/registrations";
```

Add, right before the `// ── Assembled template ──` section:

```ts
const requiredRegistrations: RequiredRegistration[] = [
  { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
];
```

Add `requiredRegistrations,` to the assembled `ncDorSalesUseTemplate` object:

```ts
export const ncDorSalesUseTemplate: TaxPartyTemplate = {
  key: "nc_dor_sales_use",
  label: "NC DOR — Sales & Use Tax",
  supportedFrequencies: ["monthly", "quarterly"],
  computePeriod,
  defaultDueRule,
  computeWorksheet: (ctx: ComputeContext) => computeNcDorWorksheet(ctx),
  fieldOwnership,
  mergeWorksheet,
  settingsSchema,
  scheduleConfigSchema,
  requiredRegistrations,
  buildReferenceView,
  recomputeLabel: "Recompute from Square",
  worksheetComponent: "nc_dor_sales_use",
};
```

- [ ] **Step 3: Typecheck to confirm Task 2's two errors are gone**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Add template test assertions**

In `lib/tax/parties/ncDorBeerExcise/template.test.ts`, add this test inside the existing `describe("nc_dor_beer_excise template", ...)` block:

```ts
  it("required registrations are NC DOR account # and the ABC permit", () => {
    expect(p.requiredRegistrations).toEqual([
      { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Permit Number" },
    ]);
  });
```

In `lib/tax/parties/ncDorSalesUse/template.test.ts`, add (using the same `ncDorSalesUseTemplate` import already at the top of the file):

```ts
describe("ncDorSalesUseTemplate.requiredRegistrations", () => {
  it("requires the NC DOR account # (shared with beer excise, not its own separate registration)", () => {
    expect(ncDorSalesUseTemplate.requiredRegistrations).toEqual([
      { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
    ]);
  });
});
```

- [ ] **Step 5: Run both template test files**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/template.test.ts lib/tax/parties/ncDorSalesUse/template.test.ts`
Expected: PASS

- [ ] **Step 6: Wire `GET /api/tax/parties`**

In `app/api/tax/parties/route.ts`, add the imports. Change:

```ts
import { listParties } from "@/lib/tax/registry";
import { buildRateMap, listTaxRates } from "@/lib/tax/rates";
```

to:

```ts
import { listParties } from "@/lib/tax/registry";
import { buildRateMap, listTaxRates } from "@/lib/tax/rates";
import { listRegistrations, resolveRequiredRegistrations, BASE_REQUIRED_REGISTRATIONS } from "@/lib/tax/registrations";
```

Change the `GET` handler body. Change:

```ts
  try {
    const sb = createSupabaseAdminClient();
    const rateMap = buildRateMap(await listTaxRates(sb));
    const parties = listParties().map((party) => ({
      key: party.key,
      label: party.label,
      supportedFrequencies: party.supportedFrequencies,
      settingsSchema: party.settingsSchema,
      scheduleConfigSchema: party.scheduleConfigSchema,
      referenceView: party.buildReferenceView(rateMap),
      recomputeLabel: party.recomputeLabel,
      worksheetComponent: party.worksheetComponent,
      defaultDueRules: Object.fromEntries(
        party.supportedFrequencies.map((f) => [f, party.defaultDueRule(f)]),
      ),
    }));
    return NextResponse.json(parties);
  } catch (err) {
    return apiError(err);
  }
```

to:

```ts
  try {
    const sb = createSupabaseAdminClient();
    const [rateMap, registrations] = await Promise.all([
      listTaxRates(sb).then(buildRateMap),
      listRegistrations(sb),
    ]);
    const parties = listParties().map((party) => ({
      key: party.key,
      label: party.label,
      supportedFrequencies: party.supportedFrequencies,
      settingsSchema: party.settingsSchema,
      scheduleConfigSchema: party.scheduleConfigSchema,
      requiredRegistrations: resolveRequiredRegistrations(
        [...BASE_REQUIRED_REGISTRATIONS, ...party.requiredRegistrations],
        registrations,
      ),
      referenceView: party.buildReferenceView(rateMap),
      recomputeLabel: party.recomputeLabel,
      worksheetComponent: party.worksheetComponent,
      defaultDueRules: Object.fromEntries(
        party.supportedFrequencies.map((f) => [f, party.defaultDueRule(f)]),
      ),
    }));
    return NextResponse.json(parties);
  } catch (err) {
    return apiError(err);
  }
```

- [ ] **Step 7: Change `GET /api/tax/registrations`'s response shape**

In `app/api/tax/registrations/route.ts`, add the imports. Change:

```ts
import { listRegistrations, saveRegistrations, type TaxRegistrationInput } from "@/lib/tax/registrations";
```

to:

```ts
import {
  listRegistrations,
  saveRegistrations,
  resolveRequiredRegistrations,
  BASE_REQUIRED_REGISTRATIONS,
  type TaxRegistrationInput,
} from "@/lib/tax/registrations";
import { listActivePartyKeys } from "@/lib/tax/schedules";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";
```

Change the `GET` handler. Change:

```ts
export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    return NextResponse.json(await listRegistrations(sb));
  } catch (err) {
    return apiError(err);
  }
}
```

to:

```ts
export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [registrations, activePartyKeys] = await Promise.all([
      listRegistrations(sb),
      listActivePartyKeys(sb),
    ]);
    const requirements = [
      ...BASE_REQUIRED_REGISTRATIONS,
      ...activePartyKeys.flatMap((key) => getParty(key).requiredRegistrations),
    ];
    const required = resolveRequiredRegistrations(requirements, registrations);
    return NextResponse.json({ registrations, required });
  } catch (err) {
    return apiError(err);
  }
}
```

(The `PUT` handler is unchanged — still receives/returns the same `{ rows }`/`{ ok: true }` shape; only `GET`'s response shape changes.)

- [ ] **Step 8: Update `useTaxData.ts`**

In `app/finance/tax/hooks/useTaxData.ts`, update the `TaxPartyMeta` interface. Change:

```ts
import type { FieldSpec, Frequency, ReferenceSpec, TaxSchedule, TaxTask } from "@/lib/tax/types";
import type { TaxRegistration } from "@/lib/tax/registrations";
import type { DueRule } from "@/lib/tax/dueDate";

/**
 * Serialized shape of `GET /api/tax/parties` — registry metadata only, no
 * filing data. Mirrors the field set built in app/api/tax/parties/route.ts
 * (`settingsSchema`/`scheduleConfigSchema` are needed by the schedule editor
 * to render party-specific config fields, e.g. NC DOR's county weights).
 */
export interface TaxPartyMeta {
  key: string;
  label: string;
  supportedFrequencies: string[];
  settingsSchema: FieldSpec[];
  scheduleConfigSchema: FieldSpec[];
  referenceView: ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;
  defaultDueRules: Partial<Record<Frequency, DueRule>>;
}
```

to:

```ts
import type { FieldSpec, Frequency, ReferenceSpec, TaxSchedule, TaxTask } from "@/lib/tax/types";
import type { TaxRegistration, ResolvedRequiredRegistration } from "@/lib/tax/registrations";
import type { DueRule } from "@/lib/tax/dueDate";

/**
 * Serialized shape of `GET /api/tax/parties` — registry metadata only, no
 * filing data. Mirrors the field set built in app/api/tax/parties/route.ts
 * (`settingsSchema`/`scheduleConfigSchema` are needed by the schedule editor
 * to render party-specific config fields, e.g. NC DOR's county weights;
 * `requiredRegistrations` is already fully resolved server-side — base +
 * this party's own requirements, matched against live tax_registrations).
 */
export interface TaxPartyMeta {
  key: string;
  label: string;
  supportedFrequencies: string[];
  settingsSchema: FieldSpec[];
  scheduleConfigSchema: FieldSpec[];
  requiredRegistrations: ResolvedRequiredRegistration[];
  referenceView: ReferenceSpec;
  recomputeLabel?: string;
  worksheetComponent: string;
  defaultDueRules: Partial<Record<Frequency, DueRule>>;
}

/** Serialized shape of `GET /api/tax/registrations`. */
export interface RegistrationsResponse {
  registrations: TaxRegistration[];
  required: ResolvedRequiredRegistration[];
}
```

Update `useRegistrationsQuery` and add `useLegalRepresentativeQuery`. Change:

```ts
export function useRegistrationsQuery() {
  return useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<TaxRegistration[]>("/api/tax/registrations"),
  });
}
```

to:

```ts
export function useRegistrationsQuery() {
  return useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<RegistrationsResponse>("/api/tax/registrations"),
  });
}

export function useLegalRepresentativeQuery() {
  return useQuery({
    queryKey: queryKeys.tax.legalRepresentative(),
    queryFn: () => fetchJson<Record<string, string>>("/api/tax/legal-representative"),
  });
}
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `app/finance/settings/tax-profile/RegistrationsSection.tsx` (still expects the old bare-array shape — fixed in Task 4) and `app/finance/tax/[taskId]/TaxWorksheetShell.tsx` (still expects the old shape/props — fixed in Task 5). No errors anywhere else.

- [ ] **Step 10: Commit**

```bash
git add lib/tax/parties/ncDorBeerExcise/template.ts lib/tax/parties/ncDorBeerExcise/template.test.ts lib/tax/parties/ncDorSalesUse/template.ts lib/tax/parties/ncDorSalesUse/template.test.ts app/api/tax/parties/route.ts app/api/tax/registrations/route.ts app/finance/tax/hooks/useTaxData.ts
git commit -m "feat(tax): resolve required registrations server-side for both parties"
```

---

## Task 4: Tax Profile settings UI — Legal Representative section + Required/Other split

**Files:**
- Modify: `app/finance/settings/tax-profile/page.tsx`
- Modify: `app/finance/settings/tax-profile/RegistrationsSection.tsx`

**Interfaces:**
- Consumes: `LEGAL_REPRESENTATIVE_SCHEMA` (Task 1, `lib/tax/legalRepresentative.ts`); `queryKeys.tax.legalRepresentative()` (Task 1); `RegistrationsResponse`/`ResolvedRequiredRegistration` (Task 3, `useTaxData.ts`/`lib/tax/registrations.ts`); the existing generic `IdentityForm` component (`app/finance/settings/tax-filing/IdentityForm.tsx`, unchanged — same props it already takes for the "Filer Identity" section).
- Produces: no new exports — this is the leaf UI consuming everything built in Tasks 1–3.

- [ ] **Step 1: Add the "Legal Representative" section to the Tax Profile page**

In `app/finance/settings/tax-profile/page.tsx`, add the import. Change:

```ts
import { ENTITY_PROFILE_SCHEMA } from "@/lib/tax/entity";
import IdentityForm from "../tax-filing/IdentityForm";
import RegistrationsSection from "./RegistrationsSection";
```

to:

```ts
import { ENTITY_PROFILE_SCHEMA } from "@/lib/tax/entity";
import { LEGAL_REPRESENTATIVE_SCHEMA } from "@/lib/tax/legalRepresentative";
import IdentityForm from "../tax-filing/IdentityForm";
import RegistrationsSection from "./RegistrationsSection";
```

Add a new `<section>` right after the "Filer Identity" section and before "Registrations". Change:

```tsx
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Filer Identity</h3>
          <IdentityForm
            schema={ENTITY_PROFILE_SCHEMA}
            endpoint="/api/tax/entity-profile"
            queryKey={queryKeys.tax.entityProfile()}
            savedLabel="Tax profile saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Registrations</h3>
          <RegistrationsSection />
        </section>
```

to:

```tsx
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Filer Identity</h3>
          <IdentityForm
            schema={ENTITY_PROFILE_SCHEMA}
            endpoint="/api/tax/entity-profile"
            queryKey={queryKeys.tax.entityProfile()}
            savedLabel="Tax profile saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Legal Representative</h3>
          <IdentityForm
            schema={LEGAL_REPRESENTATIVE_SCHEMA}
            endpoint="/api/tax/legal-representative"
            queryKey={queryKeys.tax.legalRepresentative()}
            savedLabel="Legal representative saved."
          />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-primary">Registrations</h3>
          <RegistrationsSection />
        </section>
```

Also update the page's description text to mention the representative. Change:

```tsx
          description="Filer identity and the account/license numbers registered with each tax authority."
```

to:

```tsx
          description="Business identity, the legal representative who signs filings, and the account/license numbers registered with each tax authority."
```

- [ ] **Step 2: Rewrite `RegistrationsSection.tsx`** to split into "Required for active filings" and "Other registrations"

Replace the full file contents with:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxAuthority } from "@/lib/tax/authorities";
import type { TaxRegistrationInput } from "@/lib/tax/registrations";
import type { RegistrationsResponse } from "../../tax/hooks/useTaxData";

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

interface Row {
  id?: string;
  label: string;
  number: string;
}

type Drafts = Record<string, Row[]>;
type RequiredDrafts = Record<string, string>; // "authorityKey:registrationKey" -> number

function dedupeKey(authorityKey: string, registrationKey: string): string {
  return `${authorityKey}:${registrationKey}`;
}

/**
 * Groups the FREEFORM ("Other") rows by authority, excluding any row whose
 * (authority_key, key) is already covered by a resolved requirement — those
 * are edited in the "Required for active filings" block instead, never both.
 */
function groupOtherRegistrations(
  authorities: TaxAuthority[],
  data: RegistrationsResponse,
): Drafts {
  const requiredIds = new Set(data.required.map((r) => r.id).filter((id): id is string => Boolean(id)));
  const drafts: Drafts = {};
  for (const authority of authorities) {
    drafts[authority.key] = [];
  }
  for (const reg of data.registrations) {
    if (requiredIds.has(reg.id)) continue;
    if (!drafts[reg.authority_key]) drafts[reg.authority_key] = [];
    drafts[reg.authority_key].push({ id: reg.id, label: reg.label, number: reg.number ?? "" });
  }
  return drafts;
}

function initialRequiredDrafts(data: RegistrationsResponse): RequiredDrafts {
  const drafts: RequiredDrafts = {};
  for (const req of data.required) {
    drafts[dedupeKey(req.authorityKey, req.registrationKey)] = req.number ?? "";
  }
  return drafts;
}

/**
 * Per-authority registration/license numbers (`tax_registrations`). Two
 * blocks:
 *  - Required for active filings: one row per resolved requirement
 *    (`GET /api/tax/registrations`'s `required` field) — label locked, only
 *    the number is editable, matched by (authority_key, key), never "first
 *    row for this authority".
 *  - Other registrations: today's freeform per-authority editor, minus
 *    whatever's already covered above.
 * Both flatten into ONE `PUT /api/tax/registrations` call on Save — the
 * full-reconcile-on-save contract (lib/tax/registrations.ts's
 * `saveRegistrations`) is unchanged.
 */
export default function RegistrationsSection() {
  const qc = useQueryClient();
  const authoritiesQuery = useQuery({
    queryKey: queryKeys.tax.authorities(),
    queryFn: () => fetchJson<TaxAuthority[]>("/api/tax/authorities"),
  });
  const registrationsQuery = useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<RegistrationsResponse>("/api/tax/registrations"),
  });

  const [requiredDrafts, setRequiredDrafts] = useState<RequiredDrafts>({});
  const [otherDrafts, setOtherDrafts] = useState<Drafts>({});
  const initializedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (authoritiesQuery.data && registrationsQuery.data && !initializedRef.current) {
      setRequiredDrafts(initialRequiredDrafts(registrationsQuery.data));
      setOtherDrafts(groupOtherRegistrations(authoritiesQuery.data, registrationsQuery.data));
      initializedRef.current = true;
    }
  }, [authoritiesQuery.data, registrationsQuery.data]);

  const isLoading = authoritiesQuery.isLoading || registrationsQuery.isLoading;
  const isError = authoritiesQuery.isError || registrationsQuery.isError;

  if (isLoading) return <p className="text-sm text-faint">Loading…</p>;
  if (isError) {
    return (
      <Banner tone="danger">
        {authoritiesQuery.error instanceof Error
          ? authoritiesQuery.error.message
          : registrationsQuery.error instanceof Error
            ? registrationsQuery.error.message
            : "Failed to load tax registrations."}
      </Banner>
    );
  }

  const authorities = authoritiesQuery.data ?? [];
  const required = registrationsQuery.data?.required ?? [];

  function updateRequired(authorityKey: string, registrationKey: string, number: string) {
    setRequiredDrafts((cur) => ({ ...cur, [dedupeKey(authorityKey, registrationKey)]: number }));
    setSaved(false);
  }

  function updateOtherRow(authorityKey: string, index: number, patch: Partial<Row>) {
    setOtherDrafts((cur) => {
      const rows = cur[authorityKey] ?? [];
      const nextRows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      return { ...cur, [authorityKey]: nextRows };
    });
    setSaved(false);
  }

  function addOtherRow(authorityKey: string) {
    setOtherDrafts((cur) => ({
      ...cur,
      [authorityKey]: [...(cur[authorityKey] ?? []), { label: "", number: "" }],
    }));
    setSaved(false);
  }

  function removeOtherRow(authorityKey: string, index: number) {
    setOtherDrafts((cur) => ({
      ...cur,
      [authorityKey]: (cur[authorityKey] ?? []).filter((_, i) => i !== index),
    }));
    setSaved(false);
  }

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const rows: TaxRegistrationInput[] = [];

      for (const req of required) {
        const number = requiredDrafts[dedupeKey(req.authorityKey, req.registrationKey)] ?? "";
        rows.push({
          id: req.id,
          authority_key: req.authorityKey,
          key: req.registrationKey,
          label: req.label,
          number: number.trim() || null,
          display_order: 0,
        });
      }

      for (const authorityKey of Object.keys(otherDrafts)) {
        const authorityRows = otherDrafts[authorityKey] ?? [];
        let order = 0;
        for (const row of authorityRows) {
          // A registration needs a label; skip blank rows (incl. a number typed
          // with no label — meaningless without one).
          if (!row.label.trim()) continue;
          rows.push({
            id: row.id,
            authority_key: authorityKey,
            label: row.label.trim(),
            number: row.number.trim() || null,
            display_order: order,
          });
          order += 1;
        }
      }

      await putJson("/api/tax/registrations", { rows });
      initializedRef.current = false;
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.tax.registrations() }),
        qc.invalidateQueries({ queryKey: queryKeys.tax.authorities() }),
        qc.invalidateQueries({ queryKey: queryKeys.tax.parties() }),
      ]);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save registrations.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <div className="space-y-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {saved && <Banner tone="success">Registrations saved.</Banner>}

        {required.length > 0 && (
          <div className="space-y-2 pb-4 border-b border-line">
            <h4 className="text-sm font-medium text-primary">Required for active filings</h4>
            <div className="space-y-2">
              {required.map((req) => (
                <div key={dedupeKey(req.authorityKey, req.registrationKey)} className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-body">{req.label}</span>
                  <input
                    type="text"
                    className="inp-sm flex-1"
                    placeholder="Number"
                    value={requiredDrafts[dedupeKey(req.authorityKey, req.registrationKey)] ?? ""}
                    onChange={(e) => updateRequired(req.authorityKey, req.registrationKey, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-sm font-medium text-primary">Other registrations</h4>
          {authorities.length === 0 && <p className="text-sm text-faint">No tax authorities configured.</p>}

          {authorities.map((authority) => (
            <div key={authority.key} className="space-y-2 pb-4 border-b border-line last:border-0 last:pb-0">
              <h5 className="text-xs font-medium text-faint uppercase tracking-wide">{authority.label}</h5>
              <div className="space-y-2">
                {(otherDrafts[authority.key] ?? []).map((row, index) => (
                  <div key={row.id ?? `new-${index}`} className="flex items-center gap-2">
                    <input
                      type="text"
                      className="inp-sm flex-1"
                      placeholder="Label (e.g. Permit #)"
                      value={row.label}
                      onChange={(e) => updateOtherRow(authority.key, index, { label: e.target.value })}
                    />
                    <input
                      type="text"
                      className="inp-sm flex-1"
                      placeholder="Number"
                      value={row.number}
                      onChange={(e) => updateOtherRow(authority.key, index, { number: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn-secondary btn-xxs"
                      onClick={() => removeOtherRow(authority.key, index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {(otherDrafts[authority.key] ?? []).length === 0 && (
                  <p className="text-xs text-faint">No other registrations for this authority.</p>
                )}
              </div>
              <button type="button" className="btn-secondary btn-xxs" onClick={() => addOtherRow(authority.key)}>
                + Add registration
              </button>
            </div>
          ))}
        </div>

        {(authorities.length > 0 || required.length > 0) && (
          <div className="flex justify-end pt-2 border-t border-line">
            <button type="button" className="btn-primary" onClick={handleSave} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `app/finance/settings/tax-profile/page.tsx` or `RegistrationsSection.tsx`. (`TaxWorksheetShell.tsx` errors from Task 3 are still expected here — Task 5 fixes them.)

- [ ] **Step 4: Commit**

```bash
git add app/finance/settings/tax-profile/page.tsx app/finance/settings/tax-profile/RegistrationsSection.tsx
git commit -m "feat(tax): add Legal Representative settings section, split registrations into required/other"
```

---

## Task 5: Worksheet header — consume required registrations + the legal representative

**Files:**
- Modify: `app/finance/tax/[taskId]/TaxWorksheetShell.tsx`

**Interfaces:**
- Consumes: `useLegalRepresentativeQuery` (Task 3, `useTaxData.ts`); `party.requiredRegistrations: ResolvedRequiredRegistration[]` (Task 3, already resolved — no client-side merging); `useEntityProfileQuery`/`formatEntityAddress` (existing, unchanged).
- Produces: no new exports — this is the final consumer.

- [ ] **Step 1: Delete the hardcoded authority map, add the representative query**

Change the imports and remove `HEADER_REGISTRATION_AUTHORITIES` entirely. Change:

```ts
import type { FieldSpec, TaxTask, WorksheetData } from "@/lib/tax/types";
import type { TaxRegistration } from "@/lib/tax/registrations";
import { useTaxPartiesQuery, useEntityProfileQuery, useRegistrationsQuery } from "../hooks/useTaxData";
import { getWorksheetModule } from "../parties/registry";
import CompletePanel from "./CompletePanel";

const AUTOSAVE_DEBOUNCE_MS = 800;

// Which tax_registrations authorities are relevant to each party's Filing
// Identity header. FEIN (irs) and the NC DOR account/license # apply to
// every party filed with NC DOR today; the ABC permit is alcohol-specific
// (beer excise only).
const HEADER_REGISTRATION_AUTHORITIES: Record<string, { authorityKey: string; label: string }[]> = {
  nc_dor_beer_excise: [
    { authorityKey: "irs", label: "FEIN" },
    { authorityKey: "nc_dor", label: "NCDOR ID / Account Number" },
    { authorityKey: "nc_abc", label: "ABC Permit Number" },
  ],
  nc_dor_sales_use: [
    { authorityKey: "irs", label: "FEIN" },
    { authorityKey: "nc_dor", label: "NCDOR ID / Account Number" },
  ],
};

function formatEntityAddress(entity: Record<string, string>): string {
```

to:

```ts
import type { FieldSpec, TaxTask, WorksheetData } from "@/lib/tax/types";
import type { ResolvedRequiredRegistration } from "@/lib/tax/registrations";
import { useTaxPartiesQuery, useEntityProfileQuery, useLegalRepresentativeQuery } from "../hooks/useTaxData";
import { getWorksheetModule } from "../parties/registry";
import CompletePanel from "./CompletePanel";

const AUTOSAVE_DEBOUNCE_MS = 800;

function formatEntityAddress(entity: Record<string, string>): string {
```

- [ ] **Step 2: Swap the query hook usage**

Change:

```ts
  const entityProfileQuery = useEntityProfileQuery();
  const registrationsQuery = useRegistrationsQuery();
```

to:

```ts
  const entityProfileQuery = useEntityProfileQuery();
  const representativeQuery = useLegalRepresentativeQuery();
```

- [ ] **Step 3: Update the `<IdentityHeader />` call site**

Change:

```tsx
      <IdentityHeader
        schema={party?.settingsSchema ?? []}
        values={profileQuery.data}
        entity={entityProfileQuery.data}
        registrations={registrationsQuery.data}
        registrationAuthorities={HEADER_REGISTRATION_AUTHORITIES[task.party_key] ?? []}
        isLoading={profileQuery.isLoading || entityProfileQuery.isLoading || registrationsQuery.isLoading}
      />
```

to:

```tsx
      <IdentityHeader
        schema={party?.settingsSchema ?? []}
        values={profileQuery.data}
        entity={entityProfileQuery.data}
        representative={representativeQuery.data}
        requiredRegistrations={party?.requiredRegistrations ?? []}
        isLoading={profileQuery.isLoading || entityProfileQuery.isLoading || representativeQuery.isLoading}
      />
```

- [ ] **Step 4: Rewrite `IdentityHeader`**

Replace the whole function (including its doc comment). Change:

```tsx
/**
 * Party-agnostic "who is filing" header shown above every party's
 * worksheet. Three sources, in display order:
 *  1. `registrations` (tax_registrations) filtered to `registrationAuthorities`
 *     — FEIN / NCDOR ID / ABC permit, whichever this party's authorities are.
 *  2. `entity` (tax_entity_profile) — legal name, trade name, address,
 *     contact, state of domicile, phone, fax. Shared across every party.
 *  3. `schema`/`values` (the party's own `settingsSchema` /
 *     `tax_filing_profiles`) — whatever extra identity-ish fields a party
 *     still declares for itself (e.g. NC DOR Sales & Use's Square mapping
 *     fields). Empty for beer excise since Task 2 emptied its schema.
 */
function IdentityHeader({
  schema,
  values,
  entity,
  registrations,
  registrationAuthorities,
  isLoading,
}: {
  schema: FieldSpec[];
  values?: Record<string, string>;
  entity?: Record<string, string>;
  registrations?: TaxRegistration[];
  registrationAuthorities: { authorityKey: string; label: string }[];
  isLoading: boolean;
}) {
  if (isLoading) return <p className="text-xs text-faint mt-2">Loading filing identity…</p>;

  const registrationRows = registrationAuthorities.map(({ authorityKey, label }) => ({
    label,
    value: registrations?.find((r) => r.authority_key === authorityKey)?.number || "—",
  }));

  const entityRows = entity
    ? [
        { label: "Legal Entity Name", value: entity.legal_name || "—" },
        { label: "Trade Name", value: entity.trade_name || "—" },
        { label: "Address", value: formatEntityAddress(entity) },
        { label: "Name of Contact Person", value: entity.contact_name || "—" },
        { label: "State of Domicile", value: entity.state_of_domicile || "—" },
        { label: "Phone Number", value: entity.contact_phone || "—" },
        { label: "Fax Number", value: entity.fax_number || "—" },
      ]
    : [];

  const schemaRows = schema.map((field) => ({ label: field.label, value: values?.[field.key] || "—" }));

  const rows = [...registrationRows, ...entityRows, ...schemaRows];
  if (rows.length === 0) return null;

  return (
    <Card className="mt-2" padding="p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Filing Identity</p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs text-faint">{row.label}</dt>
            <dd className="text-body truncate">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
```

to:

```tsx
/**
 * Party-agnostic "who is filing" header shown above every party's
 * worksheet, in display order:
 *  1. `requiredRegistrations` — already fully resolved server-side by
 *     `GET /api/tax/parties` (base + this party's own requirements, matched
 *     by (authority_key, key) — never "first row for this authority").
 *  2. `entity` (tax_entity_profile) — legal name, trade name, address.
 *     Business-level, shared across every party.
 *  3. `representative` (tax_legal_representative) — Name of Contact Person
 *     and State of Domicile (this person's `state`, read directly — never a
 *     separate stored field).
 *  4. `entity` again — Phone Number, Fax Number. Business-level, per an
 *     explicit product decision (NOT the representative's own phone/fax).
 *  5. `schema`/`values` (the party's own `settingsSchema` /
 *     `tax_filing_profiles`) — whatever extra identity-ish fields a party
 *     still declares for itself (e.g. NC DOR Sales & Use's Square mapping
 *     fields). Empty for beer excise.
 * The representative's `title`, `ssn`, and street address are captured in
 * Tax Profile but intentionally NOT rendered here — the worksheet header
 * only shows what the paper form actually asks for.
 */
function IdentityHeader({
  schema,
  values,
  entity,
  representative,
  requiredRegistrations,
  isLoading,
}: {
  schema: FieldSpec[];
  values?: Record<string, string>;
  entity?: Record<string, string>;
  representative?: Record<string, string>;
  requiredRegistrations: ResolvedRequiredRegistration[];
  isLoading: boolean;
}) {
  if (isLoading) return <p className="text-xs text-faint mt-2">Loading filing identity…</p>;

  const registrationRows = requiredRegistrations.map((req) => ({
    label: req.label,
    value: req.number || "—",
  }));

  const entityRows = entity
    ? [
        { label: "Legal Entity Name", value: entity.legal_name || "—" },
        { label: "Trade Name", value: entity.trade_name || "—" },
        { label: "Address", value: formatEntityAddress(entity) },
      ]
    : [];

  const representativeRows = representative
    ? [
        { label: "Name of Contact Person", value: representative.name || "—" },
        { label: "State of Domicile", value: representative.state || "—" },
      ]
    : [];

  const entityContactRows = entity
    ? [
        { label: "Phone Number", value: entity.contact_phone || "—" },
        { label: "Fax Number", value: entity.fax_number || "—" },
      ]
    : [];

  const schemaRows = schema.map((field) => ({ label: field.label, value: values?.[field.key] || "—" }));

  const rows = [...registrationRows, ...entityRows, ...representativeRows, ...entityContactRows, ...schemaRows];
  if (rows.length === 0) return null;

  return (
    <Card className="mt-2" padding="p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Filing Identity</p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs text-faint">{row.label}</dt>
            <dd className="text-body truncate">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in the project.

- [ ] **Step 6: Commit**

```bash
git add "app/finance/tax/[taskId]/TaxWorksheetShell.tsx"
git commit -m "feat(tax): worksheet header consumes required registrations + legal representative"
```

---

## Final integration check (after all 5 tasks land)

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: lint + typecheck + tests all pass; coverage stays at or above the `vitest.config.ts` floor (86% lines/statements).

- [ ] **Step 2: Manual browser check** (if an authenticated manager session is available)

- Finance > Settings > Tax Profile shows three sections: Filer Identity (now without SSN/contact name/email — those moved), Legal Representative (new — name/title/phone/email/SSN/address), Registrations (split into "Required for active filings" with locked labels + editable numbers, and "Other registrations" below it).
- Open a beer-excise worksheet task: the Filing Identity header shows NCDOR ID, ABC Permit Number, FEIN (in that order), then Legal Entity Name/Trade Name/Address, then Name of Contact Person/State of Domicile (from the representative), then Phone/Fax (business-level).
- Open a sales-&-use worksheet task: the header shows NCDOR ID and FEIN (no ABC Permit row), then the same entity/representative/contact rows, then its own Square-mapping settings fields last.
