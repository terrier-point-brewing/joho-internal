-- Who started a run.
--
-- cron_runs recorded what ran, when, for how long and how it went, but not what
-- caused it — which was fine while the schedule was the only thing that could
-- cause one. Now that a job can be started by hand from Settings and from the
-- Finance transactions tabs, the monitor cannot do its job without this: the
-- whole point of that screen is explaining why the data looks the way it does,
-- and "somebody re-ran the Ramp sync at 3pm" is usually the explanation.
--
-- Both columns are optional to the code that writes them. lib/cron/runCronJob.ts
-- attempts the insert with them and retries without on rejection, so logging
-- keeps working unchanged until this is applied, and starts carrying
-- attribution the moment it is. Nothing reads these columns yet.

alter table public.cron_runs
  add column if not exists triggered_by text not null default 'schedule';

-- 'schedule' is the correct default for every row already in the table: until
-- this migration there was no other way to start a run.
alter table public.cron_runs
  drop constraint if exists cron_runs_triggered_by_check;
alter table public.cron_runs
  add constraint cron_runs_triggered_by_check check (triggered_by in ('schedule', 'manual'));

comment on column public.cron_runs.triggered_by is
  'What caused this run: ''schedule'' for the Vercel cron, ''manual'' for someone pressing Run now.';

-- Nullable, and no foreign key to auth.users. A run record is an audit trail and
-- must outlive the account that started it — a cascade would erase the history
-- of every run a departed employee ever triggered, and a restrict would block
-- deleting them at all. Scheduled runs leave it null.
alter table public.cron_runs
  add column if not exists triggered_by_user_id uuid;

comment on column public.cron_runs.triggered_by_user_id is
  'Who pressed Run now. Null for a scheduled run. Deliberately not a foreign key, so run history survives the account being removed.';

-- The monitor's one new question is "show me the runs somebody started", which
-- on a table this size is answered fine by the existing (job, started_at) index
-- plus a filter. No new index until there is a query that needs one.
