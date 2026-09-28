-- Per-user switch for the morning alert digest (lib/cron/jobs/alertDigest.ts).
--
-- On profiles, not system_settings: it is a fact about one person, set for them
-- by an admin under Settings → Environment → Users. Off by default — an email
-- nobody asked for is the fastest way to get every alert email filtered out.
-- A partner login never receives the digest whatever this says; the job
-- excludes the role outright and the Users screen offers no switch for it.
alter table public.profiles
  add column if not exists alert_emails_enabled boolean not null default false;

comment on column public.profiles.alert_emails_enabled is
  'When true, the alert-digest cron emails this user each morning with the Home alert center items they can act on. Set by an admin in Settings → Environment → Users.';
