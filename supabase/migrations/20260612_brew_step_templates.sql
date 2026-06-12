create table if not exists brew_step_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists brew_step_template_steps (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references brew_step_templates(id) on delete cascade,
  sort_order  int not null default 0,
  activity    text not null,
  time_label  text,
  temp        numeric,
  temp_unit   text not null default 'F',
  amount      numeric,
  amount_unit text,
  vsp         numeric,
  created_at  timestamptz not null default now()
);

alter table brew_step_templates  enable row level security;
alter table brew_step_template_steps enable row level security;

create policy "Authenticated users can manage brew step templates"
  on brew_step_templates for all to authenticated using (true) with check (true);

create policy "Authenticated users can manage brew step template steps"
  on brew_step_template_steps for all to authenticated using (true) with check (true);
