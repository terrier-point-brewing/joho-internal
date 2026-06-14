create table if not exists public.chart_of_accounts (
  id           uuid        primary key default gen_random_uuid(),
  account_name text        not null,
  account_number text,
  account_type text        not null,
  detail_type  text,
  description  text,
  is_active    boolean     not null default true,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  uuid        references auth.users(id)
);

alter table public.chart_of_accounts enable row level security;

create policy "Authenticated users can read chart of accounts"
  on public.chart_of_accounts for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage chart of accounts"
  on public.chart_of_accounts for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role in ('admin', 'manager')
    )
  );
