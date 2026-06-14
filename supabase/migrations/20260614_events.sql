create table events (
  id           uuid primary key default gen_random_uuid(),
  event_name   text not null,
  event_start  timestamptz not null,
  event_end    timestamptz not null,
  event_host   text not null,
  notes        text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);

alter table events enable row level security;

-- All authenticated users can view events
create policy "authenticated read events"
  on events for select
  using (auth.role() = 'authenticated');

-- Only managers and admins can write
create policy "manager write events"
  on events for insert
  with check (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('manager', 'admin')
    )
  );

create policy "manager update events"
  on events for update
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('manager', 'admin')
    )
  );

create policy "manager delete events"
  on events for delete
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role in ('manager', 'admin')
    )
  );
