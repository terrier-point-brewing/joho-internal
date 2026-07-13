# Tax Schedule Due Dates + Settings Generalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a tax task's due date configurable on the schedule (per receiving party) instead of hardcoded, and split the Tax Filing settings tab into generic filing-identity vs party-specific settings.

**Architecture:** Due date moves from the party template's hardcoded `computePeriod` into a generic, config-driven `DueRule` stored in `tax_schedules.config`. A new pure `lib/tax/dueDate.ts` owns the math; the party template provides a `defaultDueRule(freq)` fallback. Settings identity fields move to a shared `IDENTITY_SCHEMA`. No DB migration.

**Tech Stack:** Next.js 16 App Router, TS, React Query, Supabase (service-role admin client), vitest.

**Full design (authoritative for signatures + test cases):** `docs/superpowers/specs/2026-07-12-tax-schedule-due-dates-design.md`

## Execution Budget

- **Execution mode:** subagent-driven-development (per user request).
- **Spawn cap = 2** (hard — user-imposed). Group A then Group B, sequential (B depends on A's types). STOP and report before exceeding.
- **Token target:** lean — closed, self-contained briefs; no plan/spec re-reads by subagents.

## Global Constraints

- DoD command: `npm run verify` (lint + typecheck + vitest) must pass. Keep `lib/` coverage above the `vitest.config.ts` floor — `dueDate.ts` fully covered.
- New/modified `lib/` modules ship co-located `*.test.ts` covering pure logic paths.
- UI: token utilities only (no raw `zinc/amber/...`); reuse `app/components/ui` primitives (`Field`, `Banner`, `.inp`); no hand-rolled primitives. Follow `ScheduleEditor.tsx`'s existing patterns.
- API routes: validate with `apiError(msg, 400)`; mirror existing `frequency` validation style.
- TZ-safe date math: reuse `lib/tax/period.ts` UTC-noon helpers; all dates are `YYYY-MM-DD` strings.
- Dates are pinned in tests (never `new Date()` without an explicit arg).

---

## Group A — lib/tax core (due-date engine + shared identity)

**Model:** Sonnet · **Agent type:** impl · **Order:** first (Group B consumes these types).

**Files:**
- Create: `lib/tax/dueDate.ts`, `lib/tax/dueDate.test.ts`
- Create: `lib/tax/identity.ts`
- Modify: `lib/tax/types.ts` (add `TaxPartyTemplate.defaultDueRule`; re-export `DueRule`)
- Modify: `lib/tax/parties/ncDorSalesUse/template.ts` + `template.test.ts`
- Modify: `lib/tax/tasks.ts` + `lib/tax/tasks.test.ts`

**Produces (Group B consumes these exact names):**
- `DueRule { monthOffset: number; day: number | "last" }` from `lib/tax/dueDate`
- `resolveDueDate(periodEnd: string, rule: DueRule): string`
- `validateDueRule(rule: unknown): string | null`
- `readDueRule(config: Record<string, unknown> | undefined): DueRule | null`
- `IDENTITY_SCHEMA: FieldSpec[]` from `lib/tax/identity`
- `TaxPartyTemplate.defaultDueRule(freq: Frequency): DueRule`

- [ ] **A1 — `lib/tax/dueDate.ts` (TDD).** Write `dueDate.test.ts` first with the exact cases in the spec's "Test cases (`lib/tax/dueDate.test.ts`)" list (the 20th, last-day, year rollover, Feb clamp incl. leap year, `monthOffset:0`, `validateDueRule` accept/reject set, `readDueRule` null/valid). Run → fail. Implement `DueRule`, `resolveDueDate`, `validateDueRule`, `readDueRule` per the spec signatures, reusing `period.ts` helpers for month-length/rollover. Run → pass. Commit.

- [ ] **A2 — `lib/tax/identity.ts`.** Add `IDENTITY_SCHEMA: FieldSpec[]` exactly as listed in the spec's "Shared identity schema" block. No test (trivial constant). Commit.

- [ ] **A3 — types.** In `lib/tax/types.ts`, add `defaultDueRule(freq: Frequency): DueRule;` to `TaxPartyTemplate` and import `DueRule` from `./dueDate` (re-export if convenient). Typecheck will fail until A4. Commit with A4.

- [ ] **A4 — NC DOR template.** In `ncDorSalesUse/template.ts`: add `defaultDueRule` (monthly `{monthOffset:1, day:20}`, quarterly `{monthOffset:1, day:"last"}`, throw for unsupported freq like `computePeriod` does); refactor `computePeriod` to derive `due` via `resolveDueDate(end, defaultDueRule(freq))`; delete `monthlyDue`; trim `settingsSchema` to only `general_sales_tax_id` (move the removed identity FieldSpecs — they now live in `IDENTITY_SCHEMA`). Update `template.test.ts` so the computed monthly due is still `-20` and quarterly still last-day, and add/adjust a `defaultDueRule` assertion. If `lastDayOfFollowingMonth` is now unused anywhere, leave the `period.ts` export but drop the unused import here. Run tests → pass. Commit A3+A4 together.

- [ ] **A5 — `ensureTasksForSchedule` rule application.** In `lib/tax/tasks.ts`, compute `const rule = readDueRule(schedule.config) ?? party.defaultDueRule(schedule.frequency)` and stamp each row's `due_date: resolveDueDate(p.end, rule)` (bounds still from `periodsNeedingTasks`/`computePeriod`; its `.due` is ignored). Add `tasks.test.ts` cases: schedule with `config.dueRule={monthOffset:1,day:25}` → tasks due on the 25th; no `dueRule` → party default (20th). Run `npm run verify` → green. Commit.

**Group A acceptance:** `npm run verify` green; due dates for a config-less schedule unchanged (20th monthly / last-day quarterly); a `config.dueRule` override drives new task due dates.

---

## Group B — API + client (routes, editor, settings)

**Model:** Sonnet · **Agent type:** impl · **Order:** second (after Group A merged).

**Files:**
- Modify: `app/api/tax/parties/route.ts` (expose `defaultDueRules`)
- Modify: `app/api/tax/schedules/route.ts` (POST validate `config.dueRule`)
- Modify: `app/api/tax/schedules/[id]/route.ts` (PATCH validate `config.dueRule`)
- Modify: `app/finance/tax/hooks/useTaxData.ts` (`TaxPartyMeta.defaultDueRules`)
- Modify: `app/finance/tax/ScheduleEditor.tsx` (due-date field group)
- Modify: `app/finance/settings/tax-filing/page.tsx` (two sections)

**Consumes from Group A:** `DueRule`, `resolveDueDate`, `validateDueRule`, `readDueRule` (`@/lib/tax/dueDate`); `IDENTITY_SCHEMA` (`@/lib/tax/identity`); `party.defaultDueRule`.

- [ ] **B1 — parties route + meta.** In `app/api/tax/parties/route.ts`, add `defaultDueRules` to each serialized party: build `{ [f]: party.defaultDueRule(f) }` for every `f` in `party.supportedFrequencies`. In `useTaxData.ts`, add `defaultDueRules: Partial<Record<Frequency, DueRule>>` to `TaxPartyMeta` (import `DueRule`, `Frequency` from `@/lib/tax/dueDate` / `@/lib/tax/types`). Commit.

- [ ] **B2 — schedules validation.** In `app/api/tax/schedules/route.ts` (POST) and `[id]/route.ts` (PATCH): when `body.config?.dueRule` is present, run `validateDueRule`; on non-null, return `apiError(msg, 400)` before writing. Place it alongside the existing frequency check. Commit.

- [ ] **B3 — ScheduleEditor due-date group.** Add a "Due date" `Field` group per the spec's "UI — `ScheduleEditor.tsx`" section: months-after-period-end number, day-of-month number, "Last day of month" checkbox (sets `day:"last"`, disables the number), and a muted preview line via `resolveDueDate(<sample period end for current frequency>, rule)`. Seed from `readDueRule(schedule?.config) ?? party.defaultDueRules[frequency] ?? {monthOffset:1,day:"last"}`; track a `dueRuleTouched` flag to re-seed on frequency/party change until the user edits. Include `config.dueRule` in the submit body; block submit with a `Banner` when `validateDueRule` returns non-null (same pattern as `countyError`). Update the identity hint copy to reference the shared filing-identity settings. Commit.

- [ ] **B4 — settings two sections.** In `app/finance/settings/tax-filing/page.tsx`, render **Filing Identity** → `<IdentityForm partyKey={party.key} schema={IDENTITY_SCHEMA} />` and **Party Settings** → `<IdentityForm partyKey={party.key} schema={party.settingsSchema} />` (only when `party.settingsSchema.length > 0`), keeping the existing Reference Data section. `IdentityForm` is unchanged. Commit.

- [ ] **B5 — verify.** Run `npm run verify` → green. Commit any lint/type fixups.

**Group B acceptance:** `npm run verify` green; schedule editor shows/persists a due-date rule with live preview; invalid rule is rejected client + server; settings tab shows two independent forms (Filing Identity + Party Settings) that save independently.

---

## Self-Review Notes

- **Spec coverage:** Part A → Group A (A1–A5) + B1–B3; Part B → A2/A4 (schema split) + B4. All spec sections mapped.
- **Type consistency:** `DueRule`, `resolveDueDate`, `readDueRule`, `validateDueRule`, `defaultDueRule`, `IDENTITY_SCHEMA`, `defaultDueRules` used identically across groups.
- **Future-tasks-only:** no recompute code — relies on existing `ensureTasksForSchedule` `ignoreDuplicates` upsert; confirmed in A5.
