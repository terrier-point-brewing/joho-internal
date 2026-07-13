# Tax Schedule Due Dates + Settings Generalization — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm complete)
**Area:** Finance → Tax (`app/finance/tax`, `app/finance/settings/tax-filing`, `lib/tax`)

## Goal

Make a tax task's **due date within the period configurable on the schedule**,
instead of hardcoded per party template. Different receiving parties (NC DOR,
future authorities) each carry their own due-date rule, stored in the
schedule's config. In the same change, **generalize the Settings → Tax Filing
tab** so generic filing-identity fields are separated from NC-DOR-specific
settings.

No DB migration: both features ride existing jsonb columns
(`tax_schedules.config`, `tax_filing_profiles.values`).

## Background / Current State

- Due dates are **computed by the party template at task-creation time and
  frozen into `tax_tasks.due_date`** — no user override anywhere. The rule
  lives in `TaxPartyTemplate.computePeriod(freq, ref)`
  (`lib/tax/parties/ncDorSalesUse/template.ts`): monthly = 20th of the
  following month (`monthlyDue`, hardcoded), quarterly = last day of the
  following month (`lastDayOfFollowingMonth`).
- `ensureTasksForSchedule` (`lib/tax/tasks.ts`) upserts one `tax_tasks` row per
  concluded period with `onConflict: "schedule_id,period_end",
  ignoreDuplicates: true` — so existing rows are never mutated by a re-run.
- The schedule editor (`app/finance/tax/ScheduleEditor.tsx`) exposes only
  Party, Frequency, Lead days, Active, and Counties — no due-date control.
- The Settings → Tax Filing tab (`app/finance/settings/tax-filing/page.tsx`)
  renders a party's `settingsSchema` via a generic `IdentityForm`. NC DOR's
  `settingsSchema` **conflates** generic identity fields (contact,
  account_id, fein, ssn) with a party-specific one (`general_sales_tax_id`,
  the Square catalog-tax link).

## Decisions (from brainstorm)

1. **Due-date model:** generic day-of-month rule, editable on the schedule
   config (not hardcoded, not a days-from-period-end offset).
2. **Scope:** do both the due-date rule AND the settings-tab reorg together.
3. **Recompute:** editing a schedule's due-date rule affects **future tasks
   only** — existing `tax_tasks` rows are left untouched.
4. **Settings UI:** two **independent forms** (one per section), each with its
   own Save. `IdentityForm` stays generic-over-a-schema and is reused per
   section (no rework).

---

## Part A — Configurable Due-Date Rule

### Data model (no migration)

Stored in `tax_schedules.config.dueRule`:

```ts
// lib/tax/dueDate.ts
export interface DueRule {
  monthOffset: number;   // whole months after the period-END month (1 = following month, 0 = same month)
  day: number | "last";  // day-of-month 1..31 (clamped to target month length), or the last calendar day
}
```

Expresses both NC DOR rules:
- monthly → `{ monthOffset: 1, day: 20 }`
- quarterly → `{ monthOffset: 1, day: "last" }`

### New pure module `lib/tax/dueDate.ts`

Dependency-free, YYYY-MM-DD strings, TZ-safe (reuses `lib/tax/period.ts`
UTC-noon helpers). Single source of truth for due-date math.

```ts
export interface DueRule { monthOffset: number; day: number | "last" }

// Due date for the period ending `periodEnd`, per `rule`. Advances
// `monthOffset` whole months from periodEnd's month, then picks `day`
// (clamped to that month's length) or the month's last calendar day.
export function resolveDueDate(periodEnd: string, rule: DueRule): string;

// null when valid; else an error message.
// - monthOffset: integer, 0..12
// - day: "last" OR integer 1..31
export function validateDueRule(rule: unknown): string | null;

// Safe reader from a schedule.config blob (returns null when absent/invalid).
export function readDueRule(config: Record<string, unknown> | undefined): DueRule | null;
```

**Test cases (`lib/tax/dueDate.test.ts`):**
- `resolveDueDate("2026-06-30", {monthOffset:1, day:20})` → `"2026-07-20"`.
- `resolveDueDate("2026-06-30", {monthOffset:1, day:"last"})` → `"2026-07-31"`.
- Year rollover: `resolveDueDate("2026-12-31", {monthOffset:1, day:20})` → `"2027-01-20"`.
- Day clamp: `resolveDueDate("2026-01-31", {monthOffset:1, day:31})` → `"2026-02-28"`
  (Feb) and a leap year `"2028-02-29"`.
- `monthOffset:0`: `resolveDueDate("2026-06-30", {monthOffset:0, day:15})` → `"2026-06-15"`.
- `validateDueRule` rejects: non-integer monthOffset, monthOffset<0 or >12,
  day 0, day 32, day="lastly", missing keys; accepts day:"last" and 1..31.
- `readDueRule` returns null for `{}`, `{dueRule:{}}` (invalid), and the rule
  for a valid blob.

### Party template becomes the DEFAULT provider

`TaxPartyTemplate` gains:

```ts
defaultDueRule(freq: Frequency): DueRule;
```

NC DOR (`template.ts`):
- `defaultDueRule("monthly")` → `{ monthOffset: 1, day: 20 }`
- `defaultDueRule("quarterly")` → `{ monthOffset: 1, day: "last" }`
- `computePeriod` keeps computing **period bounds** from
  `monthPeriod`/`quarterPeriod`, and derives `due` via
  `resolveDueDate(end, defaultDueRule(freq))`. **Delete `monthlyDue`**; the
  `lastDayOfFollowingMonth` import is no longer needed for due (period.ts keeps
  the export for any other caller — verify none, remove if unused).

`computePeriod`'s `due` therefore equals the party default rule, so behavior is
unchanged when a schedule has no override.

### Applying the override (future-tasks-only)

`ensureTasksForSchedule` (`lib/tax/tasks.ts`) resolves the effective rule once
and stamps each new row:

```ts
const party = getParty(schedule.party_key);
const rule = readDueRule(schedule.config) ?? party.defaultDueRule(schedule.frequency);
// per period p:
due_date: resolveDueDate(p.end, rule)
```

`periodsNeedingTasks` still uses `party.computePeriod` for **bounds** (its
`due` is ignored here in favor of the resolved rule). Existing rows are
untouched by `ignoreDuplicates` → future-tasks-only is automatic; no extra
recompute code.

**Test updates (`lib/tax/tasks.test.ts`):** a schedule with
`config.dueRule = {monthOffset:1, day:25}` produces tasks with `due_date` on
the 25th; a schedule with no `dueRule` matches the party default (20th).

### Validation in routes

- `app/api/tax/schedules/route.ts` (POST) and
  `app/api/tax/schedules/[id]/route.ts` (PATCH): when the incoming
  `config.dueRule` is present, run `validateDueRule`; on error return
  `apiError(msg, 400)` — mirrors the existing `frequency` validation.

### Expose default rules to the client

- `app/api/tax/parties/route.ts`: add
  `defaultDueRules: { monthly?, quarterly?, annual? }` built by calling
  `party.defaultDueRule(f)` for each `f` in `party.supportedFrequencies`
  (a serializable map — the function itself can't cross the wire).
- `TaxPartyMeta` (`app/finance/tax/hooks/useTaxData.ts`) gains
  `defaultDueRules: Partial<Record<Frequency, DueRule>>`.

### UI — `ScheduleEditor.tsx`

New "Due date" field group (shown for every party — it's generic):
- **Months after period end** — number input, min 0, default from the seed rule.
- **Day of month** — number input 1..31, disabled when "Last day" is on.
- **Last day of month** — checkbox; when checked, `day = "last"`.
- **Preview** — a muted line rendering
  `resolveDueDate(<sample period end for the selected frequency>, rule)`, e.g.
  *"A period ending Jun 30 would be due Jul 20."* (sample end computed
  client-side from the current frequency; import `resolveDueDate` — it's pure).

State/seed rules:
- Initial value = `readDueRule(schedule?.config) ?? party.defaultDueRules[frequency] ?? {monthOffset:1, day:"last"}`.
- On **frequency change**, if the user hasn't explicitly overridden yet
  (track a `dueRuleTouched` flag), re-seed from the new frequency's party
  default. Once touched, keep the user's values.
- On party change (create mode), reset `dueRuleTouched=false` and re-seed.
- Submit: include `config.dueRule` alongside `config.counties`. Validate with
  `validateDueRule` client-side (block submit + show `Banner` like the county
  error) so the server 400 is a backstop, not the primary UX.

---

## Part B — Settings Tab Generalization

### Shared identity schema `lib/tax/identity.ts`

```ts
export const IDENTITY_SCHEMA: FieldSpec[] = [
  { key: "contact_name",  label: "Contact name",  type: "text" },
  { key: "contact_email", label: "Contact email", type: "email" },
  { key: "contact_phone", label: "Contact phone", type: "tel" },
  { key: "account_id",    label: "Filing account ID", type: "text",
    help: "The account number this receiving party issued for the filer." },
  { key: "fein",          label: "Federal EIN", type: "text", required: true },
  { key: "ssn",           label: "SSN (only if no FEIN)", type: "text", sensitive: true },
];
```

The fields **every** receiving party has. Generic in shape; values are still
stored per-party (profiles are keyed by `party_key`).

### NC DOR `settingsSchema` shrinks to party-specific

`ncDorSalesUse/template.ts` `settingsSchema` becomes just:

```ts
const settingsSchema: FieldSpec[] = [
  { key: "general_sales_tax_id", label: "Square General Sales Tax", type: "select",
    help: "..." },
];
```

The removed identity keys keep the **same field keys** in
`tax_filing_profiles.values`, so no data migration — a stored `contact_name`
now renders under the shared Filing Identity section instead of the party
schema.

### Settings page — two sections

`app/finance/settings/tax-filing/page.tsx` renders, per selected party:
1. **Filing Identity** → `<IdentityForm partyKey schema={IDENTITY_SCHEMA} />`
2. **Party Settings** → `<IdentityForm partyKey schema={party.settingsSchema} />`
   — rendered only when `party.settingsSchema.length > 0`.
3. **Reference Data** → unchanged.

`IdentityForm` is **unchanged**: it already renders any `FieldSpec[]`, handles
the `general_sales_tax_id` Square-taxes fetch (`needsSquareTaxes`), masks
`sensitive` fields, and PUTs a merge (`buildPutPayload`) so two independent
forms writing disjoint key sets to the same profile compose correctly.

### Editor hint copy

`ScheduleEditor`'s "Filing identity … is set on the party's settings, not
here" hint currently keys off `settingsSchema.length`. Update it to reference
the shared identity settings and show unconditionally (identity is always
generic) — minor copy tweak.

---

## Files Touched

**lib (business logic + tests):**
- `lib/tax/dueDate.ts` **(new)** + `lib/tax/dueDate.test.ts` **(new)**
- `lib/tax/identity.ts` **(new)** (data; test optional — trivial constant)
- `lib/tax/types.ts` — `TaxPartyTemplate.defaultDueRule`; import/export `DueRule`
- `lib/tax/tasks.ts` — resolve effective rule in `ensureTasksForSchedule`;
  test updates
- `lib/tax/parties/ncDorSalesUse/template.ts` — `defaultDueRule`, refactor
  `computePeriod`, trim `settingsSchema`; test updates

**API routes:**
- `app/api/tax/parties/route.ts` — expose `defaultDueRules`
- `app/api/tax/schedules/route.ts` — validate `config.dueRule` on POST
- `app/api/tax/schedules/[id]/route.ts` — validate `config.dueRule` on PATCH

**Client:**
- `app/finance/tax/hooks/useTaxData.ts` — `TaxPartyMeta.defaultDueRules`
- `app/finance/tax/ScheduleEditor.tsx` — due-date field group + seed/validate
- `app/finance/settings/tax-filing/page.tsx` — two sections

## Testing / DoD

- `npm run verify` green (lint + typecheck + vitest; keep lib coverage above
  the `vitest.config.ts` floor — new `dueDate.ts` fully covered).
- Manual: create/edit a schedule, set a custom due day, confirm new tasks
  (via cron/recompute path or a direct `ensureTasksForSchedule` call) land on
  the configured day and existing tasks are unchanged.

## Out of Scope / Non-Goals

- No migration; no change to `tax_tasks` schema or the
  `(schedule_id, period_end)` conflict key.
- No editing of an already-created task's `due_date` (future-tasks-only).
- No annual-frequency support for NC DOR (unchanged; `defaultDueRule` only
  needs to answer supported frequencies).
- Combined single-form settings UI (rejected in favor of two forms).
