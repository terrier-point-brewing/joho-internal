# Payroll & Shift Management — Design Spec

**Date:** 2026-06-28  
**Status:** Approved for implementation planning

---

## Overview

Add employee payroll management to the TPB Square Reports app. Bartender hours and tips are sourced from Square (Labor and Payments APIs). Salaried staff are managed via configuration only. The app computes all per-employee payroll figures needed to run Gusto payroll manually — no direct Gusto API integration exists or is planned.

**Scope:**
- Bartenders (hourly, tip-eligible): hours from Square clock-in/out, pooled tip distribution calculated proportionally, cash tip calculation, minimum guaranteed wage bonus
- Salaried employees (Brewers, Taproom Manager): configuration and confirmation view only — no computed fields
- Pay period management: biweekly, fixed cadence, admin-locked
- Two role-gated views: Taproom (manager read-only), Finance (admin full control)
- Payroll settings: configurable rates and calculation parameters with formula reference

---

## Role Access

| Capability | viewer | brewer | manager | admin |
|---|---|---|---|---|
| View open bartender payroll period | ✗ | ✗ | ✓ (read-only) | ✓ |
| Adjust open period entries | ✗ | ✗ | ✗ | ✓ |
| Lock a period | ✗ | ✗ | ✗ | ✓ |
| View locked periods | ✗ | ✗ | ✗ | ✓ |
| View salaried employee payroll | ✗ | ✗ | ✗ | ✓ |
| Edit payroll config / employees | ✗ | ✗ | ✗ | ✓ |

Manager access is restricted to `/taproom/payroll`. The Finance payroll section uses the existing admin-only layout guard.

---

## Data Model

### `payroll_config`

Global payroll settings, admin-editable. Versioned by `effective_from` so historical periods retain the rates that were active when they were computed.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `effective_from` | date | Inclusive start date for this config version |
| `base_rate_cents` | integer | Hourly base rate paid by Gusto (regular wages) |
| `guaranteed_rate_cents` | integer | Minimum guaranteed total hourly compensation (base + tips) |
| `cash_tips_rate` | numeric(5,4) | Fraction of cash take distributed as cash tips; default 0.0100 |
| `tip_distribution_model` | text | Enum: `proportional_hours` (only supported value for now) |
| `first_pay_period_start_date` | date | Anchor for deriving all biweekly period boundaries; `POST /api/payroll/periods` computes the next period's start/end as the earliest 14-day window after the last existing period (or the anchor itself for the first period) |
| `created_at` | timestamptz | |

Only one config row is "active" at any time (the one with the highest `effective_from` ≤ today).

### `employees`

One row per person on payroll. Mirrors Gusto and Square field structure.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `first_name` | text | |
| `last_name` | text | |
| `email` | text | |
| `phone_number` | text | |
| `job_title` | text | Enum: `Bartender`, `Brewer`, `Taproom Manager` |
| `employment_type` | text | Enum: `salary_no_overtime`, `salary_overtime_eligible`, `hourly` |
| `receives_tips` | boolean | Determines tip eligibility for calculations |
| `square_team_member_id` | text | Links to Square Labor API; null for non-Square employees |
| `gusto_employee_id` | text | Reference for Gusto import; display only |
| `active` | boolean | Default true; false = inactive/terminated |
| `created_at` | timestamptz | |

Payroll calculations apply only to employees where `employment_type = 'hourly'` AND `receives_tips = true`.

### `pay_periods`

One row per biweekly period. Period boundaries are derived from `payroll_config.first_pay_period_start_date` (every 14 days) but stored explicitly for query simplicity.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `start_date` | date | Inclusive |
| `end_date` | date | Inclusive |
| `status` | text | Enum: `open`, `locked` |
| `locked_at` | timestamptz | Null until locked |
| `locked_by` | uuid FK → profiles | Null until locked |
| `created_at` | timestamptz | |

### `payroll_entries`

One row per employee per period. Rows are created lazily: either when admin saves an adjustment via `PATCH /entries/[employeeId]`, or (for all eligible employees) when the period is locked. The `/preview` route is read-only and returns computed values even if no entry rows exist yet — missing entries are treated as "no adjustments."

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `pay_period_id` | uuid FK → pay_periods | |
| `employee_id` | uuid FK → employees | |
| `hours_worked` | numeric(8,4) | Computed from Square; null until first preview load |
| `paycheck_tips_cents` | integer | Computed from Square tip pool |
| `cash_tips_cents` | integer | Computed from cash take × rate × hour share |
| `bonus_cents` | integer | Computed guaranteed wage top-up |
| `adj_hours_worked` | numeric(8,4) | Admin override; null = use computed |
| `adj_paycheck_tips_cents` | integer | Admin override; null = use computed |
| `adj_cash_tips_cents` | integer | Admin override; null = use computed |
| `adj_bonus_cents` | integer | Admin override; null = use computed |
| `admin_notes` | text | Free-text field for adjustment rationale |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

On lock: computed values (or adjusted values where set) are the permanent record. The `pay_periods.status = 'locked'` flag makes all entries immutable from that point.

**Effective value logic:** `COALESCE(adj_field, computed_field)` — adjustment takes precedence when non-null.

---

## Calculation Layer

### `lib/square/labor.ts` (new)

Fetches shifts from `GET /v2/labor/shifts` filtered by `location_id`, `start_at`, `end_at`. Handles cursor pagination via `squareGetAll`. Returns `Map<square_team_member_id, hours: number>` (clock-out minus clock-in, decimal hours).

### `lib/square/payroll.ts` (new)

Fetches all payments for a date range from `GET /v2/payments`. Computes:
- **Total pooled tips** — sum of `tip_money.amount` across all payments
- **Total cash take** — sum of `amount_money` across all tenders where `type = 'CASH'`

Square's native pooled tip distribution (proportional by hours) is a POS/UI feature not exposed per-employee via API. We replicate the same formula, which produces identical results.

### `lib/payroll/calculations.ts` (new)

Pure functions — no DB or Square calls. Accepts pre-fetched Square data and config.

```
inputs:
  employees[]         — hourly tip-eligible employees with square_team_member_id
  shifts              — Map<team_member_id, hours>
  total_pooled_tips   — cents
  total_cash_take     — cents
  config              — { base_rate_cents, guaranteed_rate_cents, cash_tips_rate }

for each employee:
  hours            = shifts.get(employee.square_team_member_id) ?? 0
  total_hours      = sum of hours across all tipped employees
  hour_share       = hours / total_hours
  paycheck_tips    = round(hour_share × total_pooled_tips)
  cash_tips        = round(hour_share × cash_tips_rate × total_cash_take)
  base_pay         = hours × base_rate_cents
  guaranteed_min   = hours × guaranteed_rate_cents
  bonus            = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)
```

Returns an array of `PayrollEntryComputed` objects. Adjustments are merged by the API layer before returning to the client (`COALESCE(adj, computed)`).

Config version used is the one with the highest `effective_from` ≤ `pay_period.start_date`.

---

## API Routes

All routes use `requireRole` from `lib/auth.ts`. Business logic lives in `lib/payroll/`, not in route handlers.

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/payroll/config` | admin | Get active config |
| `PATCH` | `/api/payroll/config` | admin | Update config (creates new versioned row) |
| `GET` | `/api/payroll/employees` | admin | List all employees |
| `POST` | `/api/payroll/employees` | admin | Create employee |
| `PATCH` | `/api/payroll/employees/[id]` | admin | Update employee |
| `GET` | `/api/payroll/periods` | manager, admin | List periods with status |
| `POST` | `/api/payroll/periods` | admin | Create next period |
| `GET` | `/api/payroll/periods/[id]` | manager, admin | Period metadata |
| `GET` | `/api/payroll/periods/[id]/preview` | manager, admin | Live Square pull + calculations + merged adjustments |
| `PATCH` | `/api/payroll/periods/[id]/entries/[employeeId]` | admin | Save adjustment fields + notes |
| `POST` | `/api/payroll/periods/[id]/lock` | admin | Snapshot final values, set status = locked |

The `/preview` route is the hot path: fetches Square labor and payment data, runs `calculations.ts`, loads any stored `payroll_entries` adjustments, and returns merged per-employee results. Managers and admins both use the same endpoint; the UI handles what is editable client-side based on role and period status.

---

## UX & Navigation

### Taproom Management — `/taproom/payroll`

Added to `TAPROOM_NAV` (alongside Performance and Targets). Route-level role guard: `requireRole(['manager'])` — admin is implicitly allowed.

**Sub-pages:**
- `/taproom/payroll` — redirects to current open period
- `/taproom/payroll/[periodId]` — period detail for bartenders

**Period view:**
- Period date range header with status badge (Open / Locked)
- Period selector to navigate to prior periods (locked periods are read-only for both roles)
- `<PayrollPeriodView>` component with `showSalaried={false}`, `showGustoSummary={false}`, `editable={isAdmin && period.status === 'open'}`
- For admin on an open period: Lock button → confirmation modal showing final per-employee values → confirms lock

### Finance — `/finance/payroll`

Admin-only via existing Finance layout guard.

**Sub-pages:**
- `/finance/payroll` — period list with status badges, link to each period
- `/finance/payroll/[periodId]` — consolidated admin view
- `/finance/payroll/settings` — payroll configuration

**Period view (Finance):**
- Same `<PayrollPeriodView>` with `showSalaried={true}`, `showGustoSummary={true}`, `editable={period.status === 'open'}`
- Gusto Summary panel: per-employee table formatted to match Gusto's entry fields (Hours, Paycheck Tips, Cash Tips, Bonus, Commissions = 0, Cash Tips = 0 for salaried)
- Salaried employee confirmation list below: name, job title, employment type — no computed fields

**Payroll Settings (`/finance/payroll/settings`):**
- Rate configuration section: base rate, guaranteed rate, cash tips rate — all editable, saved as new `payroll_config` version
- Tip distribution model dropdown (currently `Proportional Hours` only, with description)
- Calculation reference block: rendered formula with current config values substituted in plain English
- Employee management table: full CRUD, includes Square team member ID and Gusto employee ID fields, active/inactive toggle

### Shared Component: `<PayrollPeriodView>`

Lives in `app/components/payroll/PayrollPeriodView.tsx`. Props:

```ts
interface PayrollPeriodViewProps {
  periodId: string;
  editable: boolean;          // admin + open period only
  showSalaried: boolean;      // false in Taproom, true in Finance
  showGustoSummary: boolean;  // false in Taproom, true in Finance
}
```

Internally uses a shared `usePayrollPeriod(periodId)` hook (React Query, key registered in `lib/query-keys.ts`) that calls `/api/payroll/periods/[id]/preview`. The Taproom and Finance pages are thin wrappers that pass different props.

---

## Key Constraints & Notes

- **No retroactive config changes.** Locking a period snapshots the config version active at `pay_period.start_date`. Changing rates after lock has no effect on that period's record.
- **Cash tips rate is configurable but not retroactive.** Changing `cash_tips_rate` in settings takes effect for the next period opened after the change.
- **Square as source of truth for open periods.** The app never caches Square labor or payment data during an open period — `/preview` always re-fetches. This means the numbers stay current if a bartender corrects a missed clock-out in Square.
- **Hour corrections go to Square.** Managers direct bartenders to fix Square records directly; the app does not offer an hours override in the normal workflow. Admin adjustments (`adj_hours_worked`) exist for exceptional cases only.
- **Bonus is a Gusto "bonus" line item**, not a regular wage. It compensates the gap between guaranteed minimum and actual earnings (base + tips). The Gusto Summary panel labels it accordingly.
- **Tip distribution model extensibility.** `tip_distribution_model` is stored in config for future flexibility (e.g., role-weighted, equal split) but only `proportional_hours` is implemented in `calculations.ts` for now.
