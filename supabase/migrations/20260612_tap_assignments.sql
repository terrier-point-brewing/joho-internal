create table if not exists tap_assignments (
  tap_number int primary key,
  recipe_id  uuid references recipes(id) on delete set null,
  label      text,
  updated_at timestamptz not null default now()
);

alter table tap_assignments enable row level security;

create policy "Authenticated users can manage tap assignments"
  on tap_assignments for all to authenticated using (true) with check (true);

-- Seed default tap count if not already present
insert into system_settings (key, value, updated_at)
values ('tap_count', '8', now())
on conflict (key) do nothing;
