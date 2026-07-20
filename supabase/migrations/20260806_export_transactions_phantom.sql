alter table public.export_transactions alter column batch_id drop not null;
alter table public.export_transactions
  add column if not exists is_phantom boolean not null default false,
  add column if not exists alert_acknowledged_at timestamptz,
  add column if not exists alert_emailed_at timestamptz;
-- partial index for the open-alert list + digest selection
create index if not exists export_transactions_open_phantom_idx
  on public.export_transactions (created_at)
  where is_phantom and alert_acknowledged_at is null;
