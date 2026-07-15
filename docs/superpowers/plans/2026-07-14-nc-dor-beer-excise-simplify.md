# NC DOR Beer Excise (B-C-710) Module Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the NC DOR Beer Excise (Form B-C-710) worksheet: move filer-identity fields into the shared Tax Profile / filing-identity header, reorder the worksheet to match the paper form's layout, drop the three no-op checkboxes in favor of an automatic timely-filing determination, rename "Part 2" to "Export Summary (gallons)" and move it above the computation, and apply form-correct number formatting (comma-grouped gallons, whole-dollar-floored money).

**Architecture:** Four independent locality groups, each touching a disjoint file set:
- **Group A** — Tax Profile data model: `tax_entity_profile` gains 3 header columns; the beer-excise party's now-redundant `settingsSchema` is emptied.
- **Group B** — Beer excise calc engine: the timely-filing flag becomes a computed field derived from `period.due` vs. "now", and the two no-op flags are deleted.
- **Group C** — Worksheet UI body: reorder sections, drop the checkboxes, apply number formatting.
- **Group D** — Shared worksheet chrome: `TaxWorksheetShell`'s `IdentityHeader` is extended to source Legal Entity Name / Trade Name / Address / Contact / State of Domicile / Phone / Fax from `tax_entity_profile`, and FEIN / NCDOR ID / ABC Permit from `tax_registrations`.

Groups are independent (no two groups edit the same file) and can be implemented in parallel; the only relationship is a soft data dependency (Group D's new header rows only populate once Group A's migration is applied — the code is null-safe either way, matching this codebase's existing human-gated-migration convention).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Vitest, Tailwind v4 token utilities.

## Global Constraints

- Never introduce raw Tailwind color utilities (`zinc-*`/`amber-*`/etc.) or hex/rgb literals — use the existing token classes already used throughout these files (`text-body`, `text-strong`, `text-faint`, `border-line`, etc.).
- Migrations are **human-gated** — write the `.sql` file, never apply it (no `execute_sql`/`apply_migration` calls against the live project).
- Every `lib/` change ships with co-located `*.test.ts` updates/additions covering the changed logic; do not drop coverage below the `vitest.config.ts` floor (lines/statements ≥ 86%).
- Reuse existing formatting helpers (`lib/format.ts`'s `formatNumber`, `lib/utils/formatting.ts`'s `fmtCents`) rather than hand-rolling number formatting.
- This repo has no `*.test.tsx` component tests (`vitest.config.ts` only includes `lib/**/*.test.ts` and `app/**/*.test.ts`) — `.tsx` changes are verified by running `npm run verify` (typecheck covers them) and, where practical, a browser check; do not invent component test scaffolding.
- Money fields in `WorksheetFields` stay integer cents internally everywhere (`derive.ts`'s exact-cents math is unchanged) — the whole-dollar floor is a **display-only** transform applied in the Worksheet UI, never baked into stored/computed cents.

---

## Task 1: Tax Profile — add header fields to `tax_entity_profile` (Group A)

**Files:**
- Create: `supabase/migrations/20260729_beer_excise_header_fields.sql`
- Modify: `lib/tax/entity.ts`

**Interfaces:**
- Consumes: `FieldSpec` type from `lib/tax/types.ts` (unchanged), `US_STATES` from `lib/tax/usStates.ts` (existing export, already documented as being for exactly this use).
- Produces: `ENTITY_PROFILE_SCHEMA` gains 3 new `FieldSpec` entries with keys `trade_name`, `fax_number`, `state_of_domicile` — Task 5 (Group D) reads these same keys off `GET /api/tax/entity-profile`'s response.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260729_beer_excise_header_fields.sql`:

```sql
-- Beer Excise Header Fields
--
-- Adds the filer-identity fields the worksheet header (every NC DOR filing,
-- not just beer excise) needs but tax_entity_profile didn't yet carry:
-- trade name (DBA), fax number, and state of domicile. These supersede the
-- same-named fields that lived on the nc_dor_beer_excise party's own
-- settingsSchema (lib/tax/parties/ncDorBeerExcise/template.ts) — moved here
-- since filer identity is shared across every party, not beer-excise-only.
-- No backfill needed: no tax_filing_profiles row exists yet for
-- nc_dor_beer_excise (confirmed empty prior to this migration), so there is
-- nothing to carry over from the old party-level fields.
--
-- Column-add steps use IF NOT EXISTS and are safe to re-run.
-- Human-gated (do not auto-apply).

alter table public.tax_entity_profile add column if not exists trade_name text;
alter table public.tax_entity_profile add column if not exists fax_number text;
alter table public.tax_entity_profile add column if not exists state_of_domicile text;

comment on column public.tax_entity_profile.trade_name is 'DBA / trade name, shown on filing worksheet headers (e.g. Form B-C-710)';
comment on column public.tax_entity_profile.fax_number is 'filer fax number, shown on filing worksheet headers';
comment on column public.tax_entity_profile.state_of_domicile is 'state the filer is domiciled in (2-letter code), shown on filing worksheet headers';
```

- [ ] **Step 2: Extend `ENTITY_PROFILE_SCHEMA`**

In `lib/tax/entity.ts`, add the import and the 3 new schema entries. Change:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";

export const ENTITY_PROFILE_SCHEMA: FieldSpec[] = [
  { key: "legal_name", label: "Legal entity name", type: "text", required: true },
  { key: "ssn", label: "SSN (only if sole proprietor / no FEIN)", type: "text", sensitive: true },
  { key: "contact_name", label: "Primary contact name", type: "text" },
  { key: "contact_email", label: "Primary contact email", type: "email" },
  { key: "contact_phone", label: "Primary contact phone", type: "tel" },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postal_code", label: "Postal code", type: "text" },
];
```

to:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";
import { US_STATES } from "./usStates";

export const ENTITY_PROFILE_SCHEMA: FieldSpec[] = [
  { key: "legal_name", label: "Legal entity name", type: "text", required: true },
  { key: "trade_name", label: "Trade name (DBA)", type: "text" },
  { key: "ssn", label: "SSN (only if sole proprietor / no FEIN)", type: "text", sensitive: true },
  { key: "contact_name", label: "Primary contact name", type: "text" },
  { key: "contact_email", label: "Primary contact email", type: "email" },
  { key: "contact_phone", label: "Primary contact phone", type: "tel" },
  { key: "fax_number", label: "Fax number", type: "tel" },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postal_code", label: "Postal code", type: "text" },
  { key: "state_of_domicile", label: "State of domicile", type: "select", options: US_STATES },
];
```

- [ ] **Step 3: Run existing entity tests to confirm nothing broke**

Run: `npx vitest run lib/tax/entity.test.ts`
Expected: PASS (the tests iterate `ENTITY_PROFILE_SCHEMA` generically and assert on specific keys like `legal_name`/`ssn`/`fein` — none of the new keys collide with existing assertions).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260729_beer_excise_header_fields.sql lib/tax/entity.ts
git commit -m "feat(tax): add trade name, fax, and state of domicile to tax entity profile"
```

---

## Task 2: Beer excise — empty the party's `settingsSchema` (Group A)

**Files:**
- Modify: `lib/tax/parties/ncDorBeerExcise/template.ts`
- Modify: `lib/tax/parties/ncDorBeerExcise/template.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ncDorBeerExciseTemplate.settingsSchema === []` — Task 5 (Group D) no longer expects `abc_permit_number`/`state_of_domicile`/`fax_number`/`signer_title` to render via the old per-party settings path (those 4 fields are gone; 3 of them are superseded by Task 1's `tax_entity_profile` columns, `signer_title` is dropped outright as unused — it was defined in this schema but never read/rendered by `Worksheet.tsx`, and it is not one of the header fields the B-C-710 form requires).

- [ ] **Step 1: Update the failing test first**

In `lib/tax/parties/ncDorBeerExcise/template.test.ts`, replace:

```ts
  it("settings schema is beer-only fields, identity is rendered separately by the settings page", () => {
    const keys = p.settingsSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["abc_permit_number","state_of_domicile","fax_number","signer_title"]));
    expect(keys).not.toContain("legal_name");
    expect(keys).not.toContain("fein");
  });
```

with:

```ts
  it("settings schema is empty — filer identity now lives in Tax Profile (tax_entity_profile / tax_registrations), not a per-party settings form", () => {
    expect(p.settingsSchema).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/template.test.ts`
Expected: FAIL — `p.settingsSchema` still contains the 4 old fields.

- [ ] **Step 3: Empty the schema and drop the now-unused import**

In `lib/tax/parties/ncDorBeerExcise/template.ts`, remove the `US_STATES` import (it's only used by the field being deleted):

```ts
import { US_STATES } from "@/lib/tax/usStates";
```

Replace the `settingsSchema` definition:

```ts
const settingsSchema: FieldSpec[] = [
  { key: "abc_permit_number", label: "ABC Permit Number", type: "text" },
  { key: "state_of_domicile", label: "State of Domicile", type: "select", options: US_STATES },
  { key: "fax_number", label: "Fax", type: "tel" },
  { key: "signer_title", label: "Signer Title", type: "text" },
];
```

with:

```ts
// Filer identity (legal name, trade name, address, contact, FEIN, NCDOR
// account #, ABC permit #, state of domicile, phone/fax) is now sourced
// entirely from the shared Tax Profile (tax_entity_profile /
// tax_registrations) — see app/finance/tax/[taskId]/TaxWorksheetShell.tsx's
// IdentityHeader. This party needs no settings of its own.
const settingsSchema: FieldSpec[] = [];
```

`FieldSpec` stays imported (still used by `scheduleConfigSchema: FieldSpec[] = [];`).

- [ ] **Step 4: Run the test again to verify it passes**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/template.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/tax/parties/ncDorBeerExcise/template.ts lib/tax/parties/ncDorBeerExcise/template.test.ts
git commit -m "refactor(tax): drop beer excise's per-party settingsSchema, superseded by Tax Profile"
```

---

## Task 3: Beer excise calc — automatic timely-filing flag, drop dead checkboxes (Group B)

**Files:**
- Modify: `lib/tax/parties/ncDorBeerExcise/calc.ts`
- Modify: `lib/tax/parties/ncDorBeerExcise/calc.test.ts`
- Modify: `lib/tax/parties/ncDorBeerExcise/fieldOwnership.ts`
- Modify: `lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts`

**Interfaces:**
- Consumes: `dayEndUtc` from `@/lib/utils/datetime` (existing export — converts a `YYYY-MM-DD` string to the brewery-local end-of-day UTC ISO instant); `ComputeContext`/`TaxPeriod` types from `@/lib/tax/types` (unchanged).
- Produces: `isFiledTimely(dueDate: string, now?: Date): boolean` (new export from `calc.ts`); `ComputeBeerExciseFiguresArgs` gains `filedTimely: boolean` (replacing the old hardcoded `flag_timely: 1`); `computeBeerExciseWorksheet(ctx, sb?, now?: Date)` gains an optional injectable `now` param (defaults to `new Date()`); `flag_amended` and `flag_no_transactions` no longer exist anywhere in the worksheet's field set; `resolveBeerFieldOwnership("flag_timely") === "computed"` (was `"manual"`). `derive.ts` and `derive.test.ts` are **unchanged** — `deriveBeerExciseFigures` already only reads whatever `flag_timely` value is already in `fields`; it never decided that value itself.

- [ ] **Step 1: Update `fieldOwnership.test.ts` first (it should fail)**

In `lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts`, move `"flag_timely"` from the manual list to the computed list. Replace:

```ts
  it.each(["gal_taxable","cents_excise_due","cents_total_payment_due","nc_excise_rate_micros","gal_produced_for_sale"])(
    "%s is computed", (k) => expect(resolveBeerFieldOwnership(k)).toBe("computed"));
  it.each(["cents_penalty","cents_interest","flag_timely","gal_ending_inventory","gal_adjustments_part3","signer_date"])(
    "%s is manual", (k) => expect(resolveBeerFieldOwnership(k)).toBe("manual"));
```

with:

```ts
  it.each(["gal_taxable","cents_excise_due","cents_total_payment_due","nc_excise_rate_micros","gal_produced_for_sale","flag_timely"])(
    "%s is computed", (k) => expect(resolveBeerFieldOwnership(k)).toBe("computed"));
  it.each(["cents_penalty","cents_interest","gal_ending_inventory","gal_adjustments_part3","signer_date"])(
    "%s is manual", (k) => expect(resolveBeerFieldOwnership(k)).toBe("manual"));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts`
Expected: FAIL — `resolveBeerFieldOwnership("flag_timely")` still returns `"manual"`.

- [ ] **Step 3: Move `flag_timely` into `COMPUTED_KEYS`**

In `lib/tax/parties/ncDorBeerExcise/fieldOwnership.ts`, add `"flag_timely"` to the `COMPUTED_KEYS` set:

```ts
const COMPUTED_KEYS = new Set([
  "gal_distribution",
  "gal_contract",
  "gal_taproom",
  "gal_wholesale",
  "gal_produced_for_sale",
  "gal_total_available",
  "gal_allowable_deductions",
  "gal_taxable",
  "nc_excise_rate_micros",
  "flag_timely",
  "cents_excise_due",
  "cents_discount",
  "cents_net_tax_due",
  "cents_total_payment_due",
]);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for `isFiledTimely` and the updated `computeBeerExciseFigures`/`computeBeerExciseWorksheet` behavior**

In `lib/tax/parties/ncDorBeerExcise/calc.test.ts`, add the `isFiledTimely` import and a new describe block right after the existing imports/before `describe("computeBeerExciseFigures", ...)`:

```ts
import {
  computeBeerExciseFigures,
  fetchExciseData,
  fetchNcRateMicros,
  computeBeerExciseWorksheet,
  isFiledTimely,
} from "./calc";

describe("isFiledTimely", () => {
  it("is timely at exactly the due date (brewery-local end of day)", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-15T22:00:00Z"))).toBe(true); // 6pm ET, still the 15th
  });
  it("is timely before the due date", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-01T12:00:00Z"))).toBe(true);
  });
  it("is not timely after the due date", () => {
    expect(isFiledTimely("2026-08-15", new Date("2026-08-16T12:00:00Z"))).toBe(false);
  });
});
```

Update the 3 existing `computeBeerExciseFigures(...)` call sites to add `filedTimely: true` (they don't assert on the discount, so `true` preserves their existing implicit behavior):

```ts
  it("maps channel gallons onto the waterfall and taxes only liable channels", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.gal_taxable).toBe(1500);
    expect(w.fields.gal_allowable_deductions).toBe(500);
    expect(w.fields.cents_excise_due).toBe(Math.round(1500 * 61.71));
    expect(w.warnings ?? []).toHaveLength(0);
  });
  it("warns on rate drift beyond tolerance", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 80000, missingDetailTxns: 0, filedTimely: true });
    expect(w.warnings?.some((s) => /differs|drift|Review/i.test(s))).toBe(true);
  });
  it("warns when taxable rows are missing NC excise detail", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 3, filedTimely: true });
    expect(w.warnings?.some((s) => /detail|coverage|backfill/i.test(s))).toBe(true);
  });
```

Add a new test asserting `filedTimely` actually drives `flag_timely`/the discount:

```ts
describe("computeBeerExciseFigures — flag_timely driven by filedTimely arg", () => {
  it("sets flag_timely=1 and applies the discount when filedTimely is true", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.flag_timely).toBe(1);
    expect(w.fields.cents_discount).toBe(Math.round((w.fields.cents_excise_due as number) * 0.02));
  });
  it("sets flag_timely=0 and no discount when filedTimely is false", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: false });
    expect(w.fields.flag_timely).toBe(0);
    expect(w.fields.cents_discount).toBe(0);
  });
  it("never produces flag_amended or flag_no_transactions fields", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0, filedTimely: true });
    expect(w.fields.flag_amended).toBeUndefined();
    expect(w.fields.flag_no_transactions).toBeUndefined();
  });
});
```

Add 2 tests to the `computeBeerExciseWorksheet fallback` describe block asserting the end-to-end `now` vs `period.due` wiring (append inside that `describe(...)` block, reusing its existing `ctx`-building pattern):

```ts
  it("flag_timely is 1 when computed before the period's due date", async () => {
    const ctx: ComputeContext = {
      schedule: { id: "s1", party_key: "nc_dor_beer_excise", frequency: "monthly", lead_days: 10, active: true, config: {}, created_at: "", updated_at: "" },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(), new Date("2026-08-01T12:00:00Z"));
    expect(ws.fields.flag_timely).toBe(1);
  });

  it("flag_timely is 0 when computed after the period's due date", async () => {
    const ctx: ComputeContext = {
      schedule: { id: "s1", party_key: "nc_dor_beer_excise", frequency: "monthly", lead_days: 10, active: true, config: {}, created_at: "", updated_at: "" },
      profile: {},
      period,
    };
    const ws = await computeBeerExciseWorksheet(ctx, stubWorksheetSb(), new Date("2026-08-20T12:00:00Z"));
    expect(ws.fields.flag_timely).toBe(0);
  });
```

(`period` here is the module-level `const period = { start: "2026-07-01", end: "2026-07-31", due: "2026-08-15" };` already declared earlier in this test file.)

- [ ] **Step 6: Run the test file to verify the new tests fail (implementation isn't there yet)**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/calc.test.ts`
Expected: FAIL — `isFiledTimely` isn't exported yet; `filedTimely` isn't a recognized arg.

- [ ] **Step 7: Implement `isFiledTimely` and thread it through**

In `lib/tax/parties/ncDorBeerExcise/calc.ts`, update the `datetime` import:

```ts
import { addDaysStr } from "@/lib/utils/datetime";
```

to:

```ts
import { addDaysStr, dayEndUtc } from "@/lib/utils/datetime";
```

Add the new pure function (place it right after the `num` helper, before `ExciseDataResult`):

```ts
/**
 * True when `now` is at or before the brewery-local end of `dueDate` — the
 * "return + full payment filed timely" condition Form B-C-710 Line 7's 2%
 * discount depends on. No longer a manual checkbox: it's decided
 * automatically from the current date vs. the filing period's due date
 * every time the worksheet is (re)computed. `now` is injectable for tests.
 */
export function isFiledTimely(dueDate: string, now: Date = new Date()): boolean {
  return now.getTime() <= new Date(dayEndUtc(dueDate)).getTime();
}
```

Update `ComputeBeerExciseFiguresArgs`:

```ts
export interface ComputeBeerExciseFiguresArgs {
  gallonsByChannel: Record<string, number>;
  ncRateMicros: number;
  storedNcCents: number;
  missingDetailTxns: number;
}
```

to:

```ts
export interface ComputeBeerExciseFiguresArgs {
  gallonsByChannel: Record<string, number>;
  ncRateMicros: number;
  storedNcCents: number;
  missingDetailTxns: number;
  filedTimely: boolean;
}
```

Update `computeBeerExciseFigures`'s destructuring and initial `fields` object. Change:

```ts
  const { gallonsByChannel, ncRateMicros, storedNcCents, missingDetailTxns } = args;
  const warnings: string[] = [];

  const fields: WorksheetFields = {
    gal_distribution: gallonsByChannel.distribution ?? 0,
    gal_contract: gallonsByChannel.contract_brewing ?? 0,
    gal_taproom: gallonsByChannel.taproom ?? 0,
    gal_wholesale: gallonsByChannel[WHOLESALE_CHANNEL] ?? 0,
    gal_beginning_inventory: 0,
    gal_deduction_other: 0,
    gal_adjustments_part3: 0,
    gal_military_part4: 0,
    gal_ending_inventory: 0,
    nc_excise_rate_micros: ncRateMicros,
    flag_timely: 1,
    flag_amended: 0,
    flag_no_transactions: 0,
    signer_date: "",
    cents_penalty: 0,
    cents_interest: 0,
  };
```

to:

```ts
  const { gallonsByChannel, ncRateMicros, storedNcCents, missingDetailTxns, filedTimely } = args;
  const warnings: string[] = [];

  const fields: WorksheetFields = {
    gal_distribution: gallonsByChannel.distribution ?? 0,
    gal_contract: gallonsByChannel.contract_brewing ?? 0,
    gal_taproom: gallonsByChannel.taproom ?? 0,
    gal_wholesale: gallonsByChannel[WHOLESALE_CHANNEL] ?? 0,
    gal_beginning_inventory: 0,
    gal_deduction_other: 0,
    gal_adjustments_part3: 0,
    gal_military_part4: 0,
    gal_ending_inventory: 0,
    nc_excise_rate_micros: ncRateMicros,
    flag_timely: filedTimely ? 1 : 0,
    signer_date: "",
    cents_penalty: 0,
    cents_interest: 0,
  };
```

Update `computeBeerExciseWorksheet`'s signature and the call site. Change:

```ts
export async function computeBeerExciseWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
): Promise<WorksheetData> {
  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [data, fetchedMicros] = await Promise.all([
    fetchExciseData(client, ctx.period),
    fetchNcRateMicros(client),
  ]);

  const warnings: string[] = [];
  const micros = fetchedMicros ?? NC_EXCISE_RATE_MICROS_FALLBACK;
  if (fetchedMicros == null) {
    warnings.push(
      "No active NC excise-tax gallon rate configured — using the statutory fallback ($0.6171/gal). Set the rate in Finance > Settings > Excise Tax.",
    );
  }

  const computed = computeBeerExciseFigures({
    gallonsByChannel: data.gallonsByChannel,
    ncRateMicros: micros,
    storedNcCents: data.storedNcCents,
    missingDetailTxns: data.missingDetailTxns,
  });
```

to:

```ts
export async function computeBeerExciseWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
  now: Date = new Date(),
): Promise<WorksheetData> {
  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [data, fetchedMicros] = await Promise.all([
    fetchExciseData(client, ctx.period),
    fetchNcRateMicros(client),
  ]);

  const warnings: string[] = [];
  const micros = fetchedMicros ?? NC_EXCISE_RATE_MICROS_FALLBACK;
  if (fetchedMicros == null) {
    warnings.push(
      "No active NC excise-tax gallon rate configured — using the statutory fallback ($0.6171/gal). Set the rate in Finance > Settings > Excise Tax.",
    );
  }

  const computed = computeBeerExciseFigures({
    gallonsByChannel: data.gallonsByChannel,
    ncRateMicros: micros,
    storedNcCents: data.storedNcCents,
    missingDetailTxns: data.missingDetailTxns,
    filedTimely: isFiledTimely(ctx.period.due, now),
  });
```

- [ ] **Step 8: Run the full test file to verify it passes**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/calc.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 9: Run the sibling test files that share this party (derive/template) to confirm no regression**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/`
Expected: PASS. (`derive.test.ts` needs no changes — `deriveBeerExciseFigures` never set `flag_timely`, it only read it. `template.test.ts`'s `mergeWorksheet` test sets `flag_timely: 1` identically on both its `current` and `recomputed` fixtures, so the ownership change doesn't alter that test's outcome — it's covered by Task 2, not this task, so don't re-edit it here.)

- [ ] **Step 10: Commit**

```bash
git add lib/tax/parties/ncDorBeerExcise/calc.ts lib/tax/parties/ncDorBeerExcise/calc.test.ts lib/tax/parties/ncDorBeerExcise/fieldOwnership.ts lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts
git commit -m "feat(tax): derive beer excise timely-filing flag from period due date, drop dead amended/no-transactions flags"
```

---

## Task 4: Beer excise Worksheet UI — reorder, drop checkboxes, form-correct formatting (Group C)

**Files:**
- Modify: `app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx`
- Modify: `lib/tax/beerExciseWorksheetMath.ts`
- Modify: `lib/tax/beerExciseWorksheetMath.test.ts`

**Interfaces:**
- Consumes: `formatNumber` from `@/lib/format` (existing export — comma-grouped whole number, e.g. `formatNumber(1234, 0) === "1,234"`); `fmtCents` from `@/lib/utils/formatting` (existing — cents → `"$X,XXX.XX"`, em-dash at exact zero).
- Produces: `floorCentsToWholeDollar(value): number` (new export from `lib/tax/beerExciseWorksheetMath.ts`) — a pure display-only helper; nothing outside this task consumes it yet.

- [ ] **Step 1: Write the failing test for the new formatting helper**

In `lib/tax/beerExciseWorksheetMath.test.ts`, add the import and a new test block:

```ts
import { recomputeClientBeerTotals, gallonsToString, stringToGallons, floorCentsToWholeDollar } from "./beerExciseWorksheetMath";
```

```ts
  it("floors cents to the containing whole dollar for form-correct .00 display", () => {
    expect(floorCentsToWholeDollar(281099)).toBe(281000);
    expect(floorCentsToWholeDollar(281000)).toBe(281000);
    expect(floorCentsToWholeDollar(0)).toBe(0);
    expect(floorCentsToWholeDollar(null)).toBe(0);
    expect(floorCentsToWholeDollar(undefined)).toBe(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tax/beerExciseWorksheetMath.test.ts`
Expected: FAIL — `floorCentsToWholeDollar` is not exported.

- [ ] **Step 3: Implement `floorCentsToWholeDollar`**

In `lib/tax/beerExciseWorksheetMath.ts`, add (after `stringToGallons`):

```ts
/**
 * Floor a cents value to its containing whole dollar (e.g. `281099` ->
 * `281000`) so a 2-decimal money formatter always renders a trailing
 * `.00` — matching Form B-C-710, which pre-prints ".00" after every money
 * line (no cents are ever reported on this form). Display-only: the
 * underlying stored/computed cents value is never altered. Never throws;
 * non-finite/null/undefined input floors to `0`.
 */
export function floorCentsToWholeDollar(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return Math.floor(safe / 100) * 100;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tax/beerExciseWorksheetMath.test.ts`
Expected: PASS

- [ ] **Step 5: Rewrite `Worksheet.tsx`**

Replace the entire contents of `app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx` with:

```tsx
"use client";

/**
 * NC DOR Beer Excise (Form B-C-710) editable worksheet — the Export Summary
 * (gallons) channel breakdown, followed by Part 1's Lines 1-11 computation.
 * Computed fields (per `fieldOwnership.ts`) render read-only and always
 * reflect the current `fields`; manual fields render as `.inp-sm` inputs
 * (whole-gallon or money). Every edit recomputes the full waterfall
 * client-side via `recomputeClientBeerTotals` (the exact server formula) so
 * the totals update instantly — the server remains the source of truth on
 * the next autosave/recompute.
 *
 * Filer identity (legal name, FEIN, ABC permit, address, etc.) is NOT
 * rendered here — it's shown once, above every party's worksheet, by
 * `TaxWorksheetShell`'s `IdentityHeader` (sourced from `tax_entity_profile`
 * / `tax_registrations` via Finance > Settings > Tax Profile).
 *
 * There is no "return filed timely" / "amended" / "no transactions this
 * period" checkbox: timely filing (and therefore the Line 7 discount) is
 * derived automatically server-side from the filing period's due date (see
 * `lib/tax/parties/ncDorBeerExcise/calc.ts`'s `isFiledTimely`), and the
 * other two flags were never read by any calculation.
 *
 * `readOnly` (set by `TaxWorksheetShell` once the parent task is
 * `completed`) forces every manual field to render display-only, the same
 * as an already-computed field, and makes `updateField` a no-op — a
 * submitted filing's figures can no longer be edited.
 */
import { useState } from "react";
import { fmtCents } from "@/lib/utils/formatting";
import { formatNumber } from "@/lib/format";
import {
  recomputeClientBeerTotals,
  gallonsToString,
  stringToGallons,
  centsToDollarString,
  dollarStringToCents,
  floorCentsToWholeDollar,
} from "@/lib/tax/beerExciseWorksheetMath";
import { isComputedField } from "./fieldOwnership";
import type { PartyWorksheetProps } from "../registry";

type Fields = Record<string, number | string | null>;

function num(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

const CHANNEL_ROWS: { fieldKey: string; label: string }[] = [
  { fieldKey: "gal_distribution", label: "Distribution" },
  { fieldKey: "gal_contract", label: "Contract brewing" },
  { fieldKey: "gal_taproom", label: "Taproom" },
  { fieldKey: "gal_wholesale", label: "Wholesale (deduction)" },
];

export default function NcDorBeerExciseWorksheet({
  fields,
  computedAt,
  onFieldsChange,
  readOnly = false,
}: PartyWorksheetProps) {
  // Keyed into every manual input so a fresh recompute (which changes
  // computedAt) remounts them and resyncs their displayed text to the new
  // server value — a same-generation keystroke never remounts, so the
  // user's in-progress typing is never clobbered by its own recompute.
  const generation = computedAt ?? "initial";

  function updateField(key: string, value: number | string | null) {
    if (readOnly) return;
    onFieldsChange(recomputeClientBeerTotals({ ...fields, [key]: value }));
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Export Summary (gallons) — per-channel breakdown feeding Line 2 */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Export Summary (gallons)</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-faint uppercase tracking-wide border-b border-line">
                <th className="py-1.5 pr-2 font-medium">Channel</th>
                <th className="py-1.5 pl-2 font-medium text-right">Gallons</th>
              </tr>
            </thead>
            <tbody>
              {CHANNEL_ROWS.map((c) => (
                <tr key={c.fieldKey} className="border-b border-line/60">
                  <td className="py-1.5 pr-2 text-body">{c.label}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-body">
                    {formatNumber(num(fields[c.fieldKey]), 0)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-2 font-semibold text-strong">Total</td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-strong">
                  {formatNumber(num(fields.gal_produced_for_sale), 0)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Part 1 — Computation of Beer Excise Tax (Form B-C-710, Lines 1-11) */}
      <section className="flex flex-col gap-2">
        <div className="border border-line rounded px-3 py-2 mb-1">
          <h4 className="text-sm font-bold text-strong">Part 1. Computation of Beer Excise Tax</h4>
        </div>

        <GallonRow fieldKey="gal_beginning_inventory" label="1. Beginning Inventory (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <GallonRow fieldKey="gal_produced_for_sale" label="2. Total Gallons Received (From Export Summary, Total)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <GallonRow fieldKey="gal_total_available" label="3. Total Gallons Available" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />

        <div className="pl-4 ml-1 border-l-2 border-line/60 flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">4. Allowable Deductions / Adjustments</p>
          <GallonRow fieldKey="gal_allowable_deductions" label="4a. Allowable Deductions — Wholesale (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_deduction_other" label="4a. Allowable Deductions — Other (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_adjustments_part3" label="4b. Adjustments to Taxable Transactions (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_military_part4" label="4c. Military Sales (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
          <GallonRow fieldKey="gal_ending_inventory" label="4d. Ending Inventory (gal)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        </div>

        <GallonRow fieldKey="gal_taxable" label="5. Total Taxable Gallons" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_excise_due" label="6. Total Excise Tax Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_discount" label="7. Discount (2% — applied automatically when filed by the due date)" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_net_tax_due" label="8. Net Tax Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
        <LineRow fieldKey="cents_penalty" label="9. Penalty" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_interest" label="10. Interest" fields={fields} generation={generation} onChangeField={updateField} readOnly={readOnly} />
        <LineRow fieldKey="cents_total_payment_due" label="11. Total Payment Due" fields={fields} generation={generation} onChangeField={updateField} emphasis readOnly={readOnly} />
      </section>

      {/* Signature */}
      <section className="flex flex-col gap-1 border-t border-line pt-4">
        <label className="text-xs text-faint" htmlFor="signer_date">
          Date Signed
        </label>
        {readOnly ? (
          <p id="signer_date" className="text-sm text-body">
            {typeof fields.signer_date === "string" && fields.signer_date ? fields.signer_date : "—"}
          </p>
        ) : (
          <input
            id="signer_date"
            key={`signer_date-${generation}`}
            type="text"
            className="inp-sm"
            defaultValue={typeof fields.signer_date === "string" ? fields.signer_date : ""}
            onChange={(e) => updateField("signer_date", e.target.value)}
            placeholder="MM-DD-YYYY"
          />
        )}
      </section>
    </div>
  );
}

/** A label + value/input row for a single money worksheet line, read-only or editable per `isComputedField` (and always read-only when `readOnly` is set). Read-only display floors to the whole dollar per Form B-C-710 (no cents reported). */
function LineRow({
  fieldKey,
  label,
  fields,
  generation,
  emphasis,
  onChangeField,
  readOnly = false,
}: {
  fieldKey: string;
  label: string;
  fields: Fields;
  generation: string;
  emphasis?: boolean;
  onChangeField: (key: string, value: number | string | null) => void;
  readOnly?: boolean;
}) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {fmtCents(floorCentsToWholeDollar(fields[fieldKey]))}
        </span>
      ) : (
        <div className="w-32">
          <MoneyInput
            key={`${fieldKey}-${generation}`}
            initialCents={fields[fieldKey]}
            onCommit={(cents) => onChangeField(fieldKey, cents)}
          />
        </div>
      )}
    </div>
  );
}

/** A label + value/input row for a single whole-gallon worksheet line, read-only or editable per `isComputedField` (and always read-only when `readOnly` is set). Read-only display is comma-grouped (e.g. `1,234`). */
function GallonRow({
  fieldKey,
  label,
  fields,
  generation,
  emphasis,
  onChangeField,
  readOnly = false,
}: {
  fieldKey: string;
  label: string;
  fields: Fields;
  generation: string;
  emphasis?: boolean;
  onChangeField: (key: string, value: number | string | null) => void;
  readOnly?: boolean;
}) {
  const computed = isComputedField(fieldKey);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/40 pb-1.5">
      <span className={`text-sm ${emphasis ? "font-semibold text-strong" : "text-body"}`}>{label}</span>
      {computed || readOnly ? (
        <span className={`text-sm tabular-nums ${emphasis ? "font-semibold text-strong" : "text-body"}`}>
          {formatNumber(num(fields[fieldKey]), 0)}
        </span>
      ) : (
        <div className="w-32">
          <GallonInput
            key={`${fieldKey}-${generation}`}
            initialGallons={fields[fieldKey]}
            onCommit={(gallons) => onChangeField(fieldKey, gallons)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Money `<input>` with its own local text state so a keystroke never gets
 * reformatted mid-edit by the recompute round-trip — only remounting (via
 * the caller's `key`) resyncs the displayed text to an externally-changed
 * value (e.g. after a server recompute).
 */
function MoneyInput({
  initialCents,
  onCommit,
}: {
  initialCents: number | string | null | undefined;
  onCommit: (cents: number) => void;
}) {
  const [text, setText] = useState(() => centsToDollarString(initialCents));
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      className="inp-sm text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(dollarStringToCents(e.target.value));
      }}
    />
  );
}

/**
 * Whole-gallon `<input>` with its own local text state, mirroring
 * `MoneyInput`'s remount-to-resync behavior via the caller's `key`.
 */
function GallonInput({
  initialGallons,
  onCommit,
}: {
  initialGallons: number | string | null | undefined;
  onCommit: (gallons: number) => void;
}) {
  const [text, setText] = useState(() => gallonsToString(initialGallons));
  return (
    <input
      type="number"
      step="1"
      inputMode="numeric"
      className="inp-sm text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(stringToGallons(e.target.value));
      }}
    />
  );
}
```

Note: `gallonsToString`/`stringToGallons` stay used **only** inside `GallonInput`'s editable text state (a `type="number"` input can't contain comma separators) — the comma-grouped display is exclusively in the read-only `<span>` branches of `LineRow`/`GallonRow`, via `formatNumber`.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors referencing `Worksheet.tsx` (unused-import errors would surface here since `gallonsToString`/`stringToGallons` are still used, `toggleFlag` and the flag-checkbox JSX are fully removed with no dangling references).

- [ ] **Step 7: Run the math test file once more (no behavior change expected, just confirming the module still loads clean)**

Run: `npx vitest run lib/tax/beerExciseWorksheetMath.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx lib/tax/beerExciseWorksheetMath.ts lib/tax/beerExciseWorksheetMath.test.ts
git commit -m "feat(tax): reorder beer excise worksheet (Export Summary above Part 1), drop checkboxes, apply form-correct number formatting"
```

---

## Task 5: Shared worksheet chrome — `IdentityHeader` sources Tax Profile + registrations (Group D)

**Files:**
- Modify: `app/finance/tax/hooks/useTaxData.ts`
- Modify: `app/finance/tax/[taskId]/TaxWorksheetShell.tsx`

**Interfaces:**
- Consumes: `TaxRegistration` type from `@/lib/tax/registrations` (existing: `{ id, authority_key, label, number, display_order }`); `queryKeys.tax.entityProfile()` / `queryKeys.tax.registrations()` (existing keys in `lib/query-keys.ts`, already used by the Tax Profile settings page); `GET /api/tax/entity-profile` (existing route, returns `Record<string,string>` with the schema keys from Task 1, masked-sensitive); `GET /api/tax/registrations` (existing route, returns `TaxRegistration[]`).
- Produces: `useEntityProfileQuery()` and `useRegistrationsQuery()` — new exported hooks from `useTaxData.ts`, each a thin `useQuery` wrapper following the exact pattern of the existing `useTaxPartiesQuery()` in the same file.

- [ ] **Step 1: Add the two query hooks**

In `app/finance/tax/hooks/useTaxData.ts`, add the import and the two hooks. Change the top imports:

```ts
import type { FieldSpec, Frequency, ReferenceSpec, TaxSchedule, TaxTask } from "@/lib/tax/types";
```

to:

```ts
import type { FieldSpec, Frequency, ReferenceSpec, TaxSchedule, TaxTask } from "@/lib/tax/types";
import type { TaxRegistration } from "@/lib/tax/registrations";
```

Add after `useTaxPartiesQuery`:

```ts
export function useEntityProfileQuery() {
  return useQuery({
    queryKey: queryKeys.tax.entityProfile(),
    queryFn: () => fetchJson<Record<string, string>>("/api/tax/entity-profile"),
  });
}

export function useRegistrationsQuery() {
  return useQuery({
    queryKey: queryKeys.tax.registrations(),
    queryFn: () => fetchJson<TaxRegistration[]>("/api/tax/registrations"),
  });
}
```

- [ ] **Step 2: Wire the new queries into `TaxWorksheetShell`**

In `app/finance/tax/[taskId]/TaxWorksheetShell.tsx`, update the hooks import. Change:

```ts
import { useTaxPartiesQuery } from "../hooks/useTaxData";
```

to:

```ts
import { useTaxPartiesQuery, useEntityProfileQuery, useRegistrationsQuery } from "../hooks/useTaxData";
import type { TaxRegistration } from "@/lib/tax/registrations";
```

Add, right after the existing `profileQuery` declaration (inside the `TaxWorksheetShell` component body):

```ts
  const entityProfileQuery = useEntityProfileQuery();
  const registrationsQuery = useRegistrationsQuery();
```

- [ ] **Step 3: Add the party → relevant-registration-authorities map and the address formatter**

In `app/finance/tax/[taskId]/TaxWorksheetShell.tsx`, add at module scope, above the `TaxWorksheetShell` component:

```ts
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
  const street = [entity.address_line1, entity.address_line2].filter(Boolean).join(", ");
  const cityStateZip = [[entity.city, entity.state].filter(Boolean).join(", "), entity.postal_code]
    .filter(Boolean)
    .join(" ");
  return [street, cityStateZip].filter(Boolean).join(" · ") || "—";
}
```

- [ ] **Step 4: Pass the new data into `IdentityHeader`**

Change:

```tsx
      <IdentityHeader
        schema={party?.settingsSchema ?? []}
        values={profileQuery.data}
        isLoading={profileQuery.isLoading}
      />
```

to:

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

- [ ] **Step 5: Rewrite `IdentityHeader`**

Replace:

```tsx
function IdentityHeader({
  schema,
  values,
  isLoading,
}: {
  schema: FieldSpec[];
  values?: Record<string, string>;
  isLoading: boolean;
}) {
  if (isLoading) return <p className="text-xs text-faint mt-2">Loading filing identity…</p>;
  if (schema.length === 0) return null;
  return (
    <Card className="mt-2" padding="p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint mb-2">Filing Identity</p>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
        {schema.map((field) => (
          <div key={field.key} className="min-w-0">
            <dt className="text-xs text-faint">{field.label}</dt>
            <dd className="text-body truncate">{values?.[field.key] || "—"}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
```

with:

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

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors referencing `TaxWorksheetShell.tsx` or `useTaxData.ts`.

- [ ] **Step 7: Commit**

```bash
git add app/finance/tax/hooks/useTaxData.ts "app/finance/tax/[taskId]/TaxWorksheetShell.tsx"
git commit -m "feat(tax): source Filing Identity header from tax_entity_profile + tax_registrations"
```

---

## Final integration check (after all 4 groups land)

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: lint + typecheck + tests all pass; coverage stays at or above the `vitest.config.ts` floor (86% lines/statements).

- [ ] **Step 2: Manual browser check**

Start the dev server, open a beer-excise tax task (`/finance/tax/[taskId]` for an `nc_dor_beer_excise` task), and confirm:
- The "Filing Identity" card above the worksheet shows FEIN, NCDOR ID / Account Number, ABC Permit Number (or "—" if unset), Legal Entity Name, Trade Name, Address, Name of Contact Person, State of Domicile, Phone Number, and Fax Number.
- "Export Summary (gallons)" renders above "Part 1. Computation of Beer Excise Tax".
- No timely/amended/no-transactions checkboxes appear anywhere.
- A gallon value ≥ 1,000 displays with a comma (e.g. `1,234`); a money line displays with `.00` and no cents (e.g. `$2,810.00`, floored not rounded — pick a period with a fractional-cent total to confirm the floor, not round-to-nearest).
- Also open an `nc_dor_sales_use` task and confirm its worksheet still renders correctly with its own Filing Identity fields still present (Square mapping fields), now alongside the new FEIN / NCDOR ID rows.
