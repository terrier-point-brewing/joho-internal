create table if not exists taproom_recipe_settings (
  recipe_id     uuid primary key references recipes(id) on delete cascade,
  is_retired    boolean not null default false,
  retired_at    timestamptz,
  retired_notes text,
  updated_at    timestamptz not null default now()
);

alter table taproom_recipe_settings enable row level security;

create policy "Authenticated users can manage taproom recipe settings"
  on taproom_recipe_settings for all to authenticated using (true) with check (true);
