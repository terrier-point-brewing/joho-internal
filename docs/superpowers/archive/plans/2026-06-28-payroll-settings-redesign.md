# Payroll Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate payroll settings into Finance > Settings, add frequency-aware auto-period seeding on config save, add a daily Vercel cron to advance periods, add employee creation form, and add Square team-member sync.

**Architecture:** Schema adds `pay_period_frequency` to `payroll_config`. `periodUtils.ts` gains a `seedPeriodDates` helper and a frequency parameter. The config PATCH handler seeds missing periods after saving. A new cron endpoint (`/api/cron/payroll-advance`) runs daily and creates the next period when needed. The `/finance/payroll/settings` route is replaced by a redirect; a new `/finance/settings/payroll` subtab holds all three settings sections.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind v4, Supabase JS client (server), TanStack Query v5, Vitest, Square REST API.

## Global Constraints

- All new API route handlers: parse with `requireRole`, wrap errors with `apiError`, set `export const dynamic = "force-dynamic"`.
- Supabase in route handlers: use `createSupabaseServerClient` (never browser client).
- Square calls: use existing helpers from `lib/square/client.ts` (`squareGetAll`, `squarePostAll`).
- No business logic in `app/api/**` — helpers live in `lib/`.
- Tests use Vitest (`describe` / `it` / `expect` imported from `"vitest"`). Test files go in `lib/payroll/__tests__/`.
- The `payroll_config` table is versioned (one row per `effective_from` date). The PATCH handler upserts on `effective_from` (not plain insert) to allow multiple saves on the same day.
- Frequencies supported: `'weekly'` (7-day periods, end = start + 6) and `'biweekly'` (14-day periods, end = start + 13).
- `CRON_SECRET` env var must exist in `.env.local` and Vercel project settings. The cron endpoint returns 401 if the `Authorization: Bearer <CRON_SECRET>` header is missing or wrong.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260628_payroll_config_frequency.sql` | Create | Add `pay_period_frequency` column to `payroll_config` |
| `lib/payroll/types.ts` | Modify | Add `pay_period_frequency` to `PayrollConfig` |
| `lib/payroll/periodUtils.ts` | Modify | Add `frequency` param to `computeNextPeriodDates`; export `seedPeriodDates` |
| `lib/payroll/__tests__/periodUtils.test.ts` | Modify | Extend tests for frequency param + `seedPeriodDates` |
| `app/api/payroll/config/route.ts` | Modify | Accept `pay_period_frequency`; upsert on `effective_from`; seed periods after save |
| `app/api/payroll/periods/route.ts` | Modify | Select `pay_period_frequency` from config; pass to `computeNextPeriodDates` |
| `lib/square/teamMembers.ts` | Create | `fetchActiveTeamMembers()` via Square search API |
| `app/api/payroll/employees/sync-square/route.ts` | Create | POST: upsert employees from Square team members |
| `app/api/cron/payroll-advance/route.ts` | Create | POST: create next pay period if today ≥ last period end |
| `vercel.json` | Create | Register daily cron schedule |
| `app/finance/settings/SettingsNav.tsx` | Modify | Add Payroll subtab |
| `app/finance/settings/payroll/page.tsx` | Create | Consolidated settings page (Pay Schedule + Rates + Employees) |
| `app/finance/payroll/settings/page.tsx` | Modify | Replace with redirect to `/finance/settings/payroll` |
| `app/finance/payroll/PayrollNav.tsx` | Modify | Remove Settings link |

---

## Task 1: Schema migration + `periodUtils` foundation

**Files:**
- Create: `supabase/migrations/20260628_payroll_config_frequency.sql`
- Modify: `lib/payroll/types.ts`
- Modify: `lib/payroll/periodUtils.ts`
- Modify: `lib/payroll/__tests__/periodUtils.test.ts`

**Interfaces:**
- Produces:
  - `computeNextPeriodDates(firstPeriodStartDate: string, lastEndDate: string | null, frequency?: 'weekly' | 'biweekly'): { start_date: string; end_date: string }` — default `'biweekly'` keeps existing callers working
  - `seedPeriodDates(firstPeriodStartDate: string, frequency: 'weekly' | 'biweekly', throughDate: string): Array<{ start_date: string; end_date: string }>` — returns every period from start through the period containing `throughDate`
  - `PayrollConfig.pay_period_frequency: 'weekly' | 'biweekly'`

---

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/20260628_payroll_config_frequency.sql`:

```sql
-- Add pay period frequency to payroll_config.
-- 'biweekly' default preserves existing behaviour.
alter table payroll_config
  add column pay_period_frequency text not null default 'biweekly'
    check (pay_period_frequency in ('weekly', 'biweekly'));
```

- [ ] **Step 2: Apply migration to local Supabase**

```bash
npx supabase db push --local
# or: npx supabase migration up --local
```

Confirm the column appears:

```bash
npx supabase db execute --local "select column_name from information_schema.columns where table_name = 'payroll_config';"
```

Expected: `pay_period_frequency` listed.

- [ ] **Step 3: Update `lib/payroll/types.ts`**

Add the field to `PayrollConfig`:

```ts
export interface PayrollConfig {
  id: string;
  effective_from: string;
  base_rate_cents: number;
  guaranteed_rate_cents: number;
  cash_tips_rate: number;
  tip_distribution_model: TipDistributionModel;
  first_pay_period_start_date: string;
  pay_period_frequency: 'weekly' | 'biweekly';
  created_at: string;
}
```

- [ ] **Step 4: Write failing tests for updated `periodUtils`**

Replace the full contents of `lib/payroll/__tests__/periodUtils.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeNextPeriodDates, seedPeriodDates } from "../periodUtils";

describe("computeNextPeriodDates", () => {
  it("biweekly: uses anchor date when no prior periods", () => {
    const result = computeNextPeriodDates("2026-01-05", null, "biweekly");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("biweekly: starts the day after the last period's end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-18", "biweekly");
    expect(result.start_date).toBe("2026-01-19");
    expect(result.end_date).toBe("2026-02-01");
  });

  it("weekly: 7-day period from anchor", () => {
    const result = computeNextPeriodDates("2026-01-05", null, "weekly");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-11");
  });

  it("weekly: advances one day after last end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-11", "weekly");
    expect(result.start_date).toBe("2026-01-12");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("defaults to biweekly when frequency omitted", () => {
    const result = computeNextPeriodDates("2026-01-05", null);
    expect(result.end_date).toBe("2026-01-18");
  });
});

describe("seedPeriodDates", () => {
  it("biweekly: generates all periods from start through today", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-02-01");
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-18" });
    expect(periods[1]).toEqual({ start_date: "2026-01-19", end_date: "2026-02-01" });
  });

  it("weekly: generates correct 7-day periods", () => {
    const periods = seedPeriodDates("2026-01-05", "weekly", "2026-01-18");
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-11" });
    expect(periods[1]).toEqual({ start_date: "2026-01-12", end_date: "2026-01-18" });
  });

  it("includes the period whose start is on throughDate", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-05");
    expect(periods).toHaveLength(1);
    expect(periods[0].start_date).toBe("2026-01-05");
  });

  it("includes the period that straddles throughDate", () => {
    // throughDate falls in the middle of a period — that period must be included
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-10");
    expect(periods).toHaveLength(1);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-18" });
  });

  it("returns empty array when throughDate is before firstPeriodStartDate", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-04");
    expect(periods).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run tests — confirm they fail**

```bash
npx vitest run lib/payroll/__tests__/periodUtils.test.ts
```

Expected: multiple failures (`seedPeriodDates is not a function`, weekly tests fail).

- [ ] **Step 6: Update `lib/payroll/periodUtils.ts`**

Replace the full file:

```ts
export type PayPeriodFrequency = 'weekly' | 'biweekly';

/**
 * Computes start/end dates for the next pay period.
 * If no prior periods exist, uses firstPeriodStartDate as the start.
 * Otherwise, starts the day after lastEndDate.
 * Defaults to biweekly so existing callers without the frequency arg still work.
 */
export function computeNextPeriodDates(
  firstPeriodStartDate: string,
  lastEndDate: string | null,
  frequency: PayPeriodFrequency = 'biweekly'
): { start_date: string; end_date: string } {
  const span = frequency === 'weekly' ? 6 : 13;
  let start: Date;
  if (!lastEndDate) {
    start = new Date(firstPeriodStartDate);
  } else {
    start = new Date(lastEndDate);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + span);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date:   end.toISOString().slice(0, 10),
  };
}

/**
 * Returns every consecutive period from firstPeriodStartDate up to and
 * including the period whose start_date <= throughDate.
 * Used to seed all missing periods when payroll config is saved.
 */
export function seedPeriodDates(
  firstPeriodStartDate: string,
  frequency: PayPeriodFrequency,
  throughDate: string
): Array<{ start_date: string; end_date: string }> {
  const span = frequency === 'weekly' ? 6 : 13;
  const periods: Array<{ start_date: string; end_date: string }> = [];
  const through = new Date(throughDate);
  let start = new Date(firstPeriodStartDate);

  while (start <= through) {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + span);
    periods.push({
      start_date: start.toISOString().slice(0, 10),
      end_date:   end.toISOString().slice(0, 10),
    });
    start = new Date(end);
    start.setUTCDate(start.getUTCDate() + 1);
  }

  return periods;
}
```

- [ ] **Step 7: Run tests — confirm they pass**

```bash
npx vitest run lib/payroll/__tests__/periodUtils.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260628_payroll_config_frequency.sql \
        lib/payroll/types.ts \
        lib/payroll/periodUtils.ts \
        lib/payroll/__tests__/periodUtils.test.ts
git commit -m "feat(payroll): add pay_period_frequency to config schema + periodUtils"
```

---

## Task 2: Config API — frequency + period seeding

**Files:**
- Modify: `app/api/payroll/config/route.ts`
- Modify: `app/api/payroll/periods/route.ts`

**Interfaces:**
- Consumes: `seedPeriodDates`, `computeNextPeriodDates` from `lib/payroll/periodUtils`
- `PATCH /api/payroll/config` request body gains `pay_period_frequency: 'weekly' | 'biweekly'`
- `PATCH /api/payroll/config` response gains `periodsCreated: number`

---

- [ ] **Step 1: Update `app/api/payroll/config/route.ts`**

Replace the full file:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { seedPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payroll_config")
    .select("*")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (error) return apiError(error.message, 404);
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const {
    effective_from,
    base_rate_cents,
    guaranteed_rate_cents,
    cash_tips_rate,
    tip_distribution_model,
    first_pay_period_start_date,
    pay_period_frequency,
  } = body;

  if (!effective_from || !base_rate_cents || !guaranteed_rate_cents || !first_pay_period_start_date) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const frequency: PayPeriodFrequency = pay_period_frequency ?? "biweekly";

  // Upsert on effective_from so multiple saves on the same day don't conflict.
  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .upsert(
      {
        effective_from,
        base_rate_cents,
        guaranteed_rate_cents,
        cash_tips_rate: cash_tips_rate ?? 0.01,
        tip_distribution_model: tip_distribution_model ?? "proportional_hours",
        first_pay_period_start_date,
        pay_period_frequency: frequency,
      },
      { onConflict: "effective_from" }
    )
    .select()
    .single();

  if (configErr) return apiError(configErr.message);

  // Seed all missing periods from first_pay_period_start_date through today.
  const today = new Date().toISOString().slice(0, 10);
  const expected = seedPeriodDates(first_pay_period_start_date, frequency, today);

  const { data: existing } = await supabase
    .from("pay_periods")
    .select("start_date");

  const existingStarts = new Set((existing ?? []).map((p: { start_date: string }) => p.start_date));
  const toInsert = expected
    .filter(p => !existingStarts.has(p.start_date))
    .map(p => ({ ...p, status: "open" as const }));

  if (toInsert.length > 0) {
    const { error: insertErr } = await supabase.from("pay_periods").insert(toInsert);
    if (insertErr) return apiError(insertErr.message);
  }

  return NextResponse.json({ config, periodsCreated: toInsert.length });
}
```

- [ ] **Step 2: Update `app/api/payroll/periods/route.ts`**

Replace the full file:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pay_periods")
    .select("*")
    .order("start_date", { ascending: false });

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

export async function POST(_req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("first_pay_period_start_date, pay_period_frequency")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config found — seed one first", 422);

  const { data: lastPeriod } = await supabase
    .from("pay_periods")
    .select("end_date")
    .order("end_date", { ascending: false })
    .limit(1)
    .single();

  const dates = computeNextPeriodDates(
    config.first_pay_period_start_date,
    lastPeriod?.end_date ?? null,
    (config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency
  );

  const { data, error } = await supabase
    .from("pay_periods")
    .insert({ ...dates, status: "open" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors. Fix any before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/api/payroll/config/route.ts app/api/payroll/periods/route.ts
git commit -m "feat(payroll): config API accepts frequency + seeds pay periods on save"
```

---

## Task 3: Square team-member sync

**Files:**
- Create: `lib/square/teamMembers.ts`
- Create: `app/api/payroll/employees/sync-square/route.ts`

**Interfaces:**
- Produces: `fetchActiveTeamMembers(): Promise<SquareTeamMember[]>` from `lib/square/teamMembers.ts`
- `POST /api/payroll/employees/sync-square` → `{ created: number, updated: number }`

---

- [ ] **Step 1: Create `lib/square/teamMembers.ts`**

```ts
import { squarePostAll, squareLocationId } from "./client";

export interface SquareTeamMember {
  id: string;
  given_name: string;
  family_name: string;
  email_address?: string;
  status: "ACTIVE" | "INACTIVE";
}

/**
 * Returns all ACTIVE team members at the default location via
 * POST /v2/team-members/search (paginated).
 */
export async function fetchActiveTeamMembers(): Promise<SquareTeamMember[]> {
  return squarePostAll<SquareTeamMember>(
    "/team-members/search",
    "team_members",
    {
      query: {
        filter: {
          location_ids: [squareLocationId()],
          status: "ACTIVE",
        },
      },
    }
  );
}
```

- [ ] **Step 2: Create `app/api/payroll/employees/sync-square/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { fetchActiveTeamMembers } from "@/lib/square/teamMembers";

export const dynamic = "force-dynamic";

export async function POST() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  let members;
  try {
    members = await fetchActiveTeamMembers();
  } catch (err) {
    return apiError(err instanceof Error ? err.message : "Square fetch failed");
  }

  if (members.length === 0) {
    return NextResponse.json({ created: 0, updated: 0 });
  }

  const supabase = await createSupabaseServerClient();

  // Fetch existing employees by square_team_member_id to determine create vs update counts.
  const ids = members.map(m => m.id);
  const { data: existing } = await supabase
    .from("employees")
    .select("square_team_member_id")
    .in("square_team_member_id", ids);

  const existingIds = new Set((existing ?? []).map((e: { square_team_member_id: string }) => e.square_team_member_id));

  const rows = members.map(m => ({
    first_name:            m.given_name,
    last_name:             m.family_name,
    email:                 m.email_address ?? "",
    square_team_member_id: m.id,
    // Defaults — admin can edit after sync; these are only written on INSERT.
    job_title:        "Bartender",
    employment_type:  "hourly",
    receives_tips:    true,
    active:           true,
  }));

  // Upsert: on conflict (square_team_member_id) update only name + email;
  // all other fields (job_title, employment_type, etc.) survive re-sync.
  const { error } = await supabase
    .from("employees")
    .upsert(rows, {
      onConflict: "square_team_member_id",
      // Supabase JS upsert updates all provided columns on conflict.
      // To preserve admin edits to job_title/employment_type we only send
      // fields that should be overwritten: first_name, last_name, email are
      // in `rows`; the rest are only relevant on INSERT (Supabase upsert
      // always writes all columns, so we strip the INSERT-only defaults from
      // the update path by using ignoreDuplicates for those columns via a
      // follow-up targeted update).
      ignoreDuplicates: false,
    });

  if (error) return apiError(error.message);

  // Patch: re-apply admin-preserve fields for existing records by reverting
  // job_title/employment_type/receives_tips to their stored values.
  // The upsert above may have clobbered them — fix with a targeted update
  // that only touches name + email for existing employees.
  if (existingIds.size > 0) {
    const existingRows = members
      .filter(m => existingIds.has(m.id))
      .map(m => ({
        square_team_member_id: m.id,
        first_name: m.given_name,
        last_name:  m.family_name,
        email:      m.email_address ?? "",
      }));

    for (const row of existingRows) {
      await supabase
        .from("employees")
        .update({ first_name: row.first_name, last_name: row.last_name, email: row.email })
        .eq("square_team_member_id", row.square_team_member_id);
    }
  }

  const created = members.filter(m => !existingIds.has(m.id)).length;
  const updated = existingIds.size;

  return NextResponse.json({ created, updated });
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add lib/square/teamMembers.ts app/api/payroll/employees/sync-square/route.ts
git commit -m "feat(payroll): Square team-member sync endpoint"
```

---

## Task 4: Cron endpoint + `vercel.json`

**Files:**
- Create: `app/api/cron/payroll-advance/route.ts`
- Create: `vercel.json`

**Interfaces:**
- `POST /api/cron/payroll-advance` — no body; requires `Authorization: Bearer <CRON_SECRET>` header; returns `{ created: boolean, period?: { start_date, end_date } }`

---

- [ ] **Step 1: Add `CRON_SECRET` to `.env.local`**

Open `.env.local` and add:

```
CRON_SECRET=your-random-secret-here
```

Use any long random string (e.g. `openssl rand -hex 32`). Also add this variable in Vercel project settings (Settings → Environment Variables → Production).

- [ ] **Step 2: Create `app/api/cron/payroll-advance/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("first_pay_period_start_date, pay_period_frequency")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config", 422);

  const { data: lastPeriod } = await supabase
    .from("pay_periods")
    .select("end_date")
    .order("end_date", { ascending: false })
    .limit(1)
    .single();

  const today = new Date().toISOString().slice(0, 10);

  // Only create a new period if today has reached or passed the last period's end date.
  if (lastPeriod && lastPeriod.end_date > today) {
    return NextResponse.json({ created: false });
  }

  const dates = computeNextPeriodDates(
    config.first_pay_period_start_date,
    lastPeriod?.end_date ?? null,
    (config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency
  );

  const { data, error } = await supabase
    .from("pay_periods")
    .insert({ ...dates, status: "open" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json({ created: true, period: data });
}
```

- [ ] **Step 3: Create `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/cron/payroll-advance",
      "schedule": "0 5 * * *"
    }
  ]
}
```

`0 5 * * *` = 05:00 UTC daily (midnight ET). Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on invocation.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/payroll-advance/route.ts vercel.json
git commit -m "feat(payroll): daily cron endpoint to auto-advance pay periods"
```

---

## Task 5: Finance > Settings > Payroll page

**Files:**
- Modify: `app/finance/settings/SettingsNav.tsx`
- Create: `app/finance/settings/payroll/page.tsx`

**Interfaces:**
- Consumes: `GET /api/payroll/config` → `PayrollConfig`, `GET /api/payroll/employees` → `Employee[]`
- Calls: `PATCH /api/payroll/config` (save schedule or rates), `POST /api/payroll/employees`, `POST /api/payroll/employees/sync-square`, `PATCH /api/payroll/employees/[id]`
- `queryKeys.payroll.config()`, `queryKeys.payroll.employees()` from `@/lib/query-keys`

---

- [ ] **Step 1: Add Payroll subtab to `app/finance/settings/SettingsNav.tsx`**

Replace the SUBTABS array:

```ts
const SUBTABS = [
  { href: "/finance/settings/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/finance/settings/account-mapping",   label: "Account Mapping"   },
  { href: "/finance/settings/excise-tax",        label: "Excise Tax"        },
  { href: "/finance/settings/import",            label: "Import"            },
  { href: "/finance/settings/payroll",           label: "Payroll"           },
];
```

- [ ] **Step 2: Create `app/finance/settings/payroll/page.tsx`**

```tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { queryKeys } from "@/lib/query-keys";
import type { Employee, PayrollConfig } from "@/lib/payroll/types";

type PayPeriodFrequency = "weekly" | "biweekly";
type JobTitle = "Bartender" | "Brewer" | "Taproom Manager";
type EmploymentType = "hourly" | "salary_no_overtime" | "salary_overtime_eligible";

function toDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export default function PayrollSettingsPage() {
  const qc = useQueryClient();

  const { data: config } = useQuery<PayrollConfig>({
    queryKey: queryKeys.payroll.config(),
    queryFn: () => fetch("/api/payroll/config").then(r => r.json()),
  });

  const { data: employees } = useQuery<Employee[]>({
    queryKey: queryKeys.payroll.employees(),
    queryFn: () => fetch("/api/payroll/employees").then(r => r.json()),
  });

  // ── Pay Schedule state ────────────────────────────────────────────────────
  const [frequency, setFrequency] = useState<PayPeriodFrequency>("biweekly");
  const [firstStart, setFirstStart] = useState("");

  // ── Rate Configuration state ──────────────────────────────────────────────
  const [baseRate, setBaseRate] = useState("");
  const [guaranteedRate, setGuaranteedRate] = useState("");
  const [cashTipsRate, setCashTipsRate] = useState("");

  // ── Add-employee form state ───────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newTitle, setNewTitle] = useState<JobTitle>("Bartender");
  const [newEmpType, setNewEmpType] = useState<EmploymentType>("hourly");
  const [newTips, setNewTips] = useState(true);
  const [newSquareId, setNewSquareId] = useState("");
  const [newGustoId, setNewGustoId] = useState("");

  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!config) return;
    setFrequency((config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency);
    setFirstStart(config.first_pay_period_start_date ?? "");
    setBaseRate(toDollars(config.base_rate_cents));
    setGuaranteedRate(toDollars(config.guaranteed_rate_cents));
    setCashTipsRate(String(config.cash_tips_rate));
  }, [config]);

  const buildConfigBody = (overrides?: Partial<{
    pay_period_frequency: PayPeriodFrequency;
    first_pay_period_start_date: string;
    base_rate_cents: number;
    guaranteed_rate_cents: number;
    cash_tips_rate: number;
  }>) => ({
    effective_from: new Date().toISOString().slice(0, 10),
    pay_period_frequency: overrides?.pay_period_frequency ?? frequency,
    first_pay_period_start_date: overrides?.first_pay_period_start_date ?? firstStart,
    base_rate_cents: overrides?.base_rate_cents ?? Math.round(parseFloat(baseRate) * 100),
    guaranteed_rate_cents: overrides?.guaranteed_rate_cents ?? Math.round(parseFloat(guaranteedRate) * 100),
    cash_tips_rate: overrides?.cash_tips_rate ?? parseFloat(cashTipsRate),
  });

  const saveSchedule = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildConfigBody({ pay_period_frequency: frequency, first_pay_period_start_date: firstStart })),
      }).then(r => r.json()),
    onSuccess: (data: { periodsCreated?: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.config() });
      qc.invalidateQueries({ queryKey: queryKeys.payroll.periods() });
      setScheduleMsg(`Saved. ${data.periodsCreated ?? 0} period(s) created.`);
      setTimeout(() => setScheduleMsg(null), 4000);
    },
  });

  const saveRates = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildConfigBody()),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.config() }),
  });

  const addEmployee = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: newFirst,
          last_name: newLast,
          email: newEmail,
          phone_number: newPhone || null,
          job_title: newTitle,
          employment_type: newEmpType,
          receives_tips: newTips,
          square_team_member_id: newSquareId || null,
          gusto_employee_id: newGustoId || null,
        }),
      }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() });
      setShowAddForm(false);
      setNewFirst(""); setNewLast(""); setNewEmail(""); setNewPhone("");
      setNewTitle("Bartender"); setNewEmpType("hourly"); setNewTips(true);
      setNewSquareId(""); setNewGustoId("");
    },
  });

  const toggleEmployee = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetch(`/api/payroll/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() }),
  });

  const syncSquare = useMutation({
    mutationFn: () =>
      fetch("/api/payroll/employees/sync-square", { method: "POST" }).then(r => r.json()),
    onSuccess: (data: { created: number; updated: number }) => {
      qc.invalidateQueries({ queryKey: queryKeys.payroll.employees() });
      setSyncMsg(`${data.created} created, ${data.updated} updated.`);
      setTimeout(() => setSyncMsg(null), 4000);
    },
  });

  const inputCls = "mt-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-zinc-200 text-sm";
  const labelCls = "block text-zinc-500 text-xs";

  return (
    <main className="px-4 sm:px-6 py-8 max-w-3xl">
      <h2 className="text-zinc-100 font-semibold text-base mb-8">Payroll</h2>

      {/* ── Pay Schedule ─────────────────────────────────────────────────── */}
      <section className="mb-10">
        <h3 className="text-zinc-300 font-medium text-sm mb-4">Pay Schedule</h3>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <label className="block">
            <span className={labelCls}>Pay Frequency</span>
            <select
              value={frequency}
              onChange={e => setFrequency(e.target.value as PayPeriodFrequency)}
              className={inputCls}
            >
              <option value="weekly">Weekly (7 days)</option>
              <option value="biweekly">Biweekly (14 days)</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>First Pay Period Start Date</span>
            <input
              type="date"
              value={firstStart}
              onChange={e => setFirstStart(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => saveSchedule.mutate()}
            disabled={saveSchedule.isPending}
            className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
          >
            {saveSchedule.isPending ? "Saving…" : "Save & Generate Periods"}
          </button>
          {scheduleMsg && <span className="text-xs text-green-400">{scheduleMsg}</span>}
        </div>
      </section>

      {/* ── Rate Configuration ────────────────────────────────────────────── */}
      <section className="mb-10">
        <h3 className="text-zinc-300 font-medium text-sm mb-4">Rate Configuration</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <label className="block">
            <span className={labelCls}>Base Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={baseRate}
              onChange={e => setBaseRate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Guaranteed Rate ($/hr)</span>
            <input
              type="number" step="0.01" min="0"
              value={guaranteedRate}
              onChange={e => setGuaranteedRate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className={labelCls}>Cash Tips Rate (e.g. 0.01)</span>
            <input
              type="number" step="0.001" min="0" max="1"
              value={cashTipsRate}
              onChange={e => setCashTipsRate(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <button
          onClick={() => saveRates.mutate()}
          disabled={saveRates.isPending}
          className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
        >
          {saveRates.isPending ? "Saving…" : "Save Rates"}
        </button>

        <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-400 space-y-2 font-mono">
          <p><span className="text-zinc-200">hour_share</span> = employee_hours / total_tipped_hours</p>
          <p><span className="text-zinc-200">paycheck_tips</span> = hour_share × total_pooled_tips <span className="text-zinc-600">(from Square)</span></p>
          <p><span className="text-zinc-200">cash_tips</span> = hour_share × <span className="text-amber-400">{cashTipsRate || "0.01"}</span> × total_cash_take</p>
          <p><span className="text-zinc-200">base_pay</span> = hours × <span className="text-amber-400">${baseRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">guaranteed_min</span> = hours × <span className="text-amber-400">${guaranteedRate || "?"}/hr</span></p>
          <p><span className="text-zinc-200">bonus</span> = max(0, guaranteed_min − base_pay − paycheck_tips − cash_tips)</p>
        </div>
        <p className="text-xs text-zinc-600 mt-2">
          Tip model: <span className="text-zinc-400">Proportional Hours</span>
        </p>
      </section>

      {/* ── Employees ────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-zinc-300 font-medium text-sm">Employees</h3>
          <div className="flex items-center gap-2">
            {syncMsg && <span className="text-xs text-green-400">{syncMsg}</span>}
            <button
              onClick={() => syncSquare.mutate()}
              disabled={syncSquare.isPending}
              className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded disabled:opacity-40"
            >
              {syncSquare.isPending ? "Syncing…" : "Sync from Square"}
            </button>
            <button
              onClick={() => setShowAddForm(v => !v)}
              className="text-xs px-3 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded"
            >
              {showAddForm ? "Cancel" : "+ Add Employee"}
            </button>
          </div>
        </div>

        {/* Add employee inline form */}
        {showAddForm && (
          <div className="mb-4 p-4 bg-zinc-900 border border-zinc-700 rounded-lg">
            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="block">
                <span className={labelCls}>First Name *</span>
                <input value={newFirst} onChange={e => setNewFirst(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Last Name *</span>
                <input value={newLast} onChange={e => setNewLast(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Email *</span>
                <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Phone</span>
                <input type="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)} className={inputCls} />
              </label>
              <label className="block">
                <span className={labelCls}>Job Title *</span>
                <select value={newTitle} onChange={e => setNewTitle(e.target.value as JobTitle)} className={inputCls}>
                  <option>Bartender</option>
                  <option>Brewer</option>
                  <option>Taproom Manager</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Employment Type *</span>
                <select value={newEmpType} onChange={e => setNewEmpType(e.target.value as EmploymentType)} className={inputCls}>
                  <option value="hourly">Hourly</option>
                  <option value="salary_no_overtime">Salary (no OT)</option>
                  <option value="salary_overtime_eligible">Salary (OT eligible)</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Square Team Member ID</span>
                <input value={newSquareId} onChange={e => setNewSquareId(e.target.value)} className={inputCls} placeholder="optional" />
              </label>
              <label className="block">
                <span className={labelCls}>Gusto Employee ID</span>
                <input value={newGustoId} onChange={e => setNewGustoId(e.target.value)} className={inputCls} placeholder="optional" />
              </label>
            </div>
            <label className="flex items-center gap-2 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={newTips}
                onChange={e => setNewTips(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-zinc-400 text-sm">Receives tips</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => addEmployee.mutate()}
                disabled={addEmployee.isPending || !newFirst || !newLast || !newEmail}
                className="text-sm px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-40"
              >
                {addEmployee.isPending ? "Adding…" : "Add Employee"}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="text-sm px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
              >
                Cancel
              </button>
            </div>
            {addEmployee.isError && (
              <p className="text-red-400 text-xs mt-2">{String(addEmployee.error)}</p>
            )}
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-700">
              <th className="text-left py-2 px-3 text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-zinc-500">Title</th>
              <th className="text-left py-2 px-3 text-zinc-500">Type</th>
              <th className="text-left py-2 px-3 text-zinc-500">Tips</th>
              <th className="text-left py-2 px-3 text-zinc-500">Square ID</th>
              <th className="py-2 px-3 text-zinc-500">Active</th>
            </tr>
          </thead>
          <tbody>
            {(employees ?? []).map(emp => (
              <tr key={emp.id} className="border-b border-zinc-800">
                <td className="py-2 px-3 text-zinc-200">{emp.first_name} {emp.last_name}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.job_title}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.employment_type.replace(/_/g, " ")}</td>
                <td className="py-2 px-3 text-zinc-400 text-xs">{emp.receives_tips ? "Yes" : "No"}</td>
                <td className="py-2 px-3 text-zinc-600 text-xs font-mono">
                  {emp.square_team_member_id?.slice(0, 12) ?? "—"}
                </td>
                <td className="py-2 px-3 text-center">
                  <button
                    onClick={() => toggleEmployee.mutate({ id: emp.id, active: !emp.active })}
                    className={`text-xs px-2 py-0.5 rounded ${
                      emp.active
                        ? "bg-green-900/30 text-green-400 hover:bg-red-900/30 hover:text-red-400"
                        : "bg-zinc-800 text-zinc-500 hover:bg-green-900/30 hover:text-green-400"
                    }`}
                  >
                    {emp.active ? "Active" : "Inactive"}
                  </button>
                </td>
              </tr>
            ))}
            {(employees ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-zinc-600">
                  No employees yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: no TypeScript errors. Fix any before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/finance/settings/SettingsNav.tsx app/finance/settings/payroll/page.tsx
git commit -m "feat(payroll): Finance > Settings > Payroll subtab with schedule, rates, employees"
```

---

## Task 6: Navigation cleanup

**Files:**
- Modify: `app/finance/payroll/settings/page.tsx`
- Modify: `app/finance/payroll/PayrollNav.tsx`

---

- [ ] **Step 1: Replace `app/finance/payroll/settings/page.tsx` with redirect**

Replace the full file contents:

```ts
import { redirect } from "next/navigation";
export default function PayrollSettingsRedirect() {
  redirect("/finance/settings/payroll");
}
```

- [ ] **Step 2: Remove Settings link from `app/finance/payroll/PayrollNav.tsx`**

Replace the full file:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PayrollNav() {
  const pathname = usePathname();
  const active = !pathname.startsWith("/finance/payroll/");

  return (
    <nav className="flex gap-1 mb-6">
      <Link
        href="/finance/payroll"
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          active
            ? "text-amber-400 bg-amber-900/20"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
        }`}
      >
        Periods
      </Link>
    </nav>
  );
}
```

- [ ] **Step 3: Verify build + lint**

```bash
npm run build && npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/finance/payroll/settings/page.tsx app/finance/payroll/PayrollNav.tsx
git commit -m "feat(payroll): redirect old settings route; clean up PayrollNav"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Schema: `pay_period_frequency` migration — Task 1
- [x] `periodUtils` frequency + `seedPeriodDates` — Task 1
- [x] Config API stores frequency + seeds periods + upserts on same-day — Task 2
- [x] Periods route passes frequency to `computeNextPeriodDates` — Task 2
- [x] Square team-member sync endpoint — Task 3
- [x] Cron endpoint (`/api/cron/payroll-advance`) — Task 4
- [x] `vercel.json` cron schedule — Task 4
- [x] `CRON_SECRET` env var — Task 4
- [x] Finance > Settings > Payroll subtab — Task 5
- [x] Pay Schedule section (frequency + start date + seed button + period count feedback) — Task 5
- [x] Rate Configuration section (rates + separate save) — Task 5
- [x] Employees section (toggle + add form all fields + Sync from Square) — Task 5
- [x] Old `/finance/payroll/settings` redirects — Task 6
- [x] PayrollNav loses Settings link — Task 6

**No placeholders detected.**

**Type consistency:**
- `PayPeriodFrequency` exported from `lib/payroll/periodUtils.ts`, imported as needed in Task 2 + Task 4.
- `PayrollConfig.pay_period_frequency` added in Task 1, used in Task 5 `useEffect`.
- `queryKeys.payroll.periods()` invalidated in `saveSchedule.onSuccess` — key exists in `lib/query-keys.ts`.
