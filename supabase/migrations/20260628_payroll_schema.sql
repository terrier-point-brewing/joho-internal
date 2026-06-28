-- supabase/migrations/20260628_payroll_schema.sql
-- Employee shift & payroll management module.

-- ── Enums ────────────────────────────────────────────────────────────────────

create type job_title_enum as enum ('Bartender', 'Brewer', 'Taproom Manager');
create type employment_type_enum as enum ('salary_no_overtime', 'salary_overtime_eligible', 'hourly');

-- ── payroll_config ───────────────────────────────────────────────────────────
-- Versioned: insert a new row when rates change; active row = highest
-- effective_from <= today. first_pay_period_start_date is the anchor for
-- computing period boundaries when no periods exist yet.

create table payroll_config (
  id                          uuid primary key default gen_random_uuid(),
  effective_from              date not null unique,
  base_rate_cents             integer not null check (base_rate_cents > 0),
  guaranteed_rate_cents       integer not null check (guaranteed_rate_cents >= base_rate_cents),
  cash_tips_rate              numeric(5,4) not null default 0.0100
                                check (cash_tips_rate >= 0 and cash_tips_rate <= 1),
  tip_distribution_model      text not null default 'proportional_hours'
                                check (tip_distribution_model in ('proportional_hours')),
  first_pay_period_start_date date not null,
  created_at                  timestamptz not null default now()
);

-- ── employees ────────────────────────────────────────────────────────────────

create table employees (
  id                    uuid primary key default gen_random_uuid(),
  first_name            text not null,
  last_name             text not null,
  email                 text not null,
  phone_number          text,
  job_title             job_title_enum not null,
  employment_type       employment_type_enum not null,
  receives_tips         boolean not null default false,
  square_team_member_id text unique,
  gusto_employee_id     text,
  active                boolean not null default true,
  created_at            timestamptz not null default now()
);

-- ── pay_periods ───────────────────────────────────────────────────────────────

create table pay_periods (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null unique,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open', 'locked')),
  locked_at   timestamptz,
  locked_by   uuid references profiles(id),
  created_at  timestamptz not null default now(),
  constraint valid_date_range check (end_date > start_date),
  constraint lock_consistency check (
    (status = 'locked' and locked_at is not null and locked_by is not null) or
    (status = 'open'   and locked_at is null     and locked_by is null)
  )
);

-- ── payroll_entries ───────────────────────────────────────────────────────────
-- Rows are written lazily: when admin saves an adjustment (PATCH /entries/[id])
-- or when a period is locked (POST /lock upserts all eligible employees).
-- computed_* fields are the Square-derived values snapshotted at lock time.
-- adj_* fields are admin overrides; null = use computed value (COALESCE logic).

create table payroll_entries (
  id                        uuid primary key default gen_random_uuid(),
  pay_period_id             uuid not null references pay_periods(id) on delete cascade,
  employee_id               uuid not null references employees(id),
  hours_worked              numeric(8,4),
  paycheck_tips_cents       integer,
  cash_tips_cents           integer,
  bonus_cents               integer,
  adj_hours_worked          numeric(8,4),
  adj_paycheck_tips_cents   integer,
  adj_cash_tips_cents       integer,
  adj_bonus_cents           integer,
  admin_notes               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (pay_period_id, employee_id)
);

create or replace function set_payroll_entries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger payroll_entries_updated_at
  before update on payroll_entries
  for each row execute procedure set_payroll_entries_updated_at();
