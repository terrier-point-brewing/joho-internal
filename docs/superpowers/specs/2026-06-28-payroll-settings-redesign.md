# Payroll Settings Redesign

**Date:** 2026-06-28  
**Status:** Approved

## Summary

Three interconnected changes:
1. Add `pay_period_frequency` to `payroll_config` and update period-date math to use it.
2. Move payroll settings into Finance > Settings as a new "Payroll" subtab; add employee creation form + Square team-member sync.
3. Auto-generate pay periods on config save (seed through today) and daily via Vercel cron (advance going forward).

---

## 1. Schema Change

### Migration: `20260628_payroll_config_frequency.sql`

Add one column to `payroll_config`:

```sql
alter table payroll_config
  add column pay_period_frequency text not null default 'biweekly'
    check (pay_period_frequency in ('weekly', 'biweekly'));
```

No other table changes. The `pay_periods` table is unaffected — individual period rows already carry their own `start_date`/`end_date`.

---

## 2. `lib/payroll/periodUtils.ts`

### Updated signature

```ts
computeNextPeriodDates(
  firstPeriodStartDate: string,
  lastEndDate: string | null,
  frequency: 'weekly' | 'biweekly'   // new
): { start_date: string; end_date: string }
```

Period length: `weekly` → 7 days (end = start + 6), `biweekly` → 14 days (end = start + 13). Logic otherwise unchanged.

### New export: `seedPeriodDates`

```ts
seedPeriodDates(
  firstPeriodStartDate: string,
  frequency: 'weekly' | 'biweekly',
  throughDate: string   // today's date
): Array<{ start_date: string; end_date: string }>
```

Returns every consecutive period from `firstPeriodStartDate` up to and including the period that contains `throughDate`. Used by config-save and cron advance.

---

## 3. Finance > Settings > Payroll Subtab

### Navigation

Add to `SettingsNav.tsx` SUBTABS array:
```ts
{ href: "/finance/settings/payroll", label: "Payroll" }
```

### New page: `app/finance/settings/payroll/page.tsx`

Three sections rendered in order:

#### 3a. Pay Schedule
- **Frequency** — `<select>` with options `Weekly` / `Biweekly`
- **First pay period start date** — `<input type="date">`
- **"Save & Generate Periods"** button — PATCH config, then triggers period seeding (see §4). On success, shows inline count: "Created 6 periods."
- All three fields load from the current `payroll_config` row on mount.

#### 3b. Rate Configuration
- Existing three fields: Base Rate ($/hr), Guaranteed Rate ($/hr), Cash Tips Rate.
- Separate "Save Rates" button — PATCH config with updated rate fields only (carries forward existing `first_pay_period_start_date` and `frequency`).
- Saving rates does NOT re-seed periods (only the Pay Schedule save does).

#### 3c. Employees
- Existing toggle table (name, title, type, tips, Square ID, active toggle).
- **"Add Employee" button** — expands an inline form below the table with all fields:
  - First name, Last name, Email, Phone (optional)
  - Job title — `<select>`: Bartender / Brewer / Taproom Manager
  - Employment type — `<select>`: Hourly / Salary (no OT) / Salary (OT eligible)
  - Receives tips — checkbox
  - Square Team Member ID (optional, text)
  - Gusto Employee ID (optional, text)
  - "Add" and "Cancel" buttons
  - POST `/api/payroll/employees` on submit; invalidates employee query on success; collapses form.
- **"Sync from Square" button** — POST `/api/payroll/employees/sync-square`; shows result toast: "3 created, 1 updated."

### Redirect

`app/finance/payroll/settings/page.tsx` → replace with:
```ts
import { redirect } from "next/navigation";
export default function() { redirect("/finance/settings/payroll"); }
```

### PayrollNav cleanup

Remove the "Settings" entry from `app/finance/payroll/PayrollNav.tsx`. Settings is now reached via Finance > Settings, not the Payroll sub-nav.

---

## 4. Auto-Period Generation

### 4a. Config-save seeding (`POST /api/payroll/config`)

After inserting the new config row, call `seedPeriodDates(firstPeriodStartDate, frequency, today)` to build the full list of expected periods, then:

```sql
INSERT INTO pay_periods (start_date, end_date, status)
VALUES (…), (…), …
ON CONFLICT (start_date) DO NOTHING;
```

Return `{ config, periodsCreated: n }` in the response body. The UI reads `periodsCreated` and shows the inline confirmation.

### 4b. Vercel cron — daily advance

**New endpoint:** `POST /api/cron/payroll-advance`

Auth: checks `Authorization: Bearer ${CRON_SECRET}` header. Returns 401 if missing/wrong.

Logic:
1. Fetch latest `payroll_config` row.
2. Fetch latest `pay_periods` row (by `end_date DESC`).
3. If today's date ≥ `lastPeriod.end_date`, compute and insert the next period using `computeNextPeriodDates`. Otherwise no-op.
4. Return `{ created: true | false }`.

**`vercel.json` addition:**
```json
{
  "crons": [
    { "path": "/api/cron/payroll-advance", "schedule": "0 5 * * *" }
  ]
}
```

`0 5 * * *` = 05:00 UTC daily (midnight ET). Vercel injects `CRON_SECRET` automatically; the endpoint validates it via the `Authorization` header.

**Environment variable:** `CRON_SECRET` — add to Vercel project settings and `.env.local`.

---

## 5. Square Team Member Sync

**New endpoint:** `POST /api/payroll/employees/sync-square`

1. Call Square `GET /v2/team-members` with `location_ids[]=LZ8TH4A632YW0` and `status=ACTIVE` (paginated via `squareGetAll`).
2. Map each team member:
   - `given_name` → `first_name`, `family_name` → `last_name`
   - `email_address` → `email` (may be null; default to empty string if missing)
   - `id` → `square_team_member_id`
   - Defaults: `job_title = 'Bartender'`, `employment_type = 'hourly'`, `receives_tips = true`, `active = true`
3. Upsert via:
   ```sql
   INSERT INTO employees (first_name, last_name, email, square_team_member_id, job_title, employment_type, receives_tips, active)
   VALUES (…)
   ON CONFLICT (square_team_member_id) DO UPDATE
     SET first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         email      = EXCLUDED.email;
   ```
   Only name and email are overwritten on update — all other fields (job_title, employment_type, etc.) are preserved so admin edits survive re-sync.
4. Return `{ created: n, updated: n }`.

**Square API shape** (from `/v2/team-members`):
```ts
interface SquareTeamMember {
  id: string;
  given_name: string;
  family_name: string;
  email_address?: string;
  status: "ACTIVE" | "INACTIVE";
}
```

---

## 6. `lib/payroll/types.ts` Update

Add `pay_period_frequency` to `PayrollConfig`:
```ts
pay_period_frequency: 'weekly' | 'biweekly';
```

---

## Files Touched

| File | Change |
|------|--------|
| `supabase/migrations/20260628_payroll_config_frequency.sql` | New: add frequency column |
| `lib/payroll/periodUtils.ts` | Add frequency param + `seedPeriodDates` export |
| `lib/payroll/types.ts` | Add `pay_period_frequency` to `PayrollConfig` |
| `app/api/payroll/config/route.ts` | Accept + store frequency; seed periods after insert |
| `app/api/payroll/periods/route.ts` | Pass frequency to `computeNextPeriodDates` |
| `app/api/payroll/employees/route.ts` | Already handles POST; no change needed |
| `app/api/payroll/employees/sync-square/route.ts` | New: Square sync endpoint |
| `app/api/cron/payroll-advance/route.ts` | New: daily cron endpoint |
| `app/finance/settings/SettingsNav.tsx` | Add Payroll subtab |
| `app/finance/settings/payroll/page.tsx` | New: consolidated settings page |
| `app/finance/settings/page.tsx` | Update redirect to include payroll in order |
| `app/finance/payroll/settings/page.tsx` | Replace with redirect to `/finance/settings/payroll` |
| `app/finance/payroll/PayrollNav.tsx` | Remove Settings link |
| `vercel.json` | Add cron schedule |

---

## Out of Scope

- Semi-monthly or monthly pay frequencies.
- Period deletion or retroactive re-seeding if frequency changes (new frequency only affects future periods).
- Gusto sync (employees carry a `gusto_employee_id` field but no sync UI is built here).
- Employee editing (add + toggle-active covers the immediate need; inline edit row is a future task).
