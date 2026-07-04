-- supabase/migrations/20260703_cron_runs.sql
-- Execution log for scheduled (Vercel cron) jobs, powering the Settings → Cron
-- Jobs monitor. Each cron run inserts one row (success or error) via the
-- service-role client, so no insert policy is needed; admins can read.

create table if not exists public.cron_runs (
  id          uuid        primary key default gen_random_uuid(),
  job         text        not null,
  status      text        not null check (status in ('success', 'error')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  duration_ms integer,
  detail      jsonb,
  error       text
);

create index if not exists idx_cron_runs_job_started on public.cron_runs (job, started_at desc);

alter table public.cron_runs enable row level security;

create policy "Admins can read cron runs"
  on public.cron_runs for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );
