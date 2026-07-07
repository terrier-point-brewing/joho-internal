-- Consolidate the three brew step/activity tables into one (schema audit track #2).
--
-- brew_step_template_steps, recipe_brew_activity_templates, and
-- batch_brew_activity_log shared an identical step payload and formed a one-way
-- copy chain (library template -> recipe default -> batch log). All three held 0
-- live rows. They are replaced by a single brew_activities table scoped by exactly
-- one of library_template_id / recipe_id / batch_id. brew_step_templates (the
-- named library parent) is kept. The unused batch-log template_id lineage is
-- dropped. No data migration (all three source tables were empty).

create table if not exists public.brew_activities (
  id                  uuid primary key default gen_random_uuid(),
  -- exactly one scope FK is populated per row (see check constraint below)
  library_template_id uuid references public.brew_step_templates(id) on delete cascade,
  recipe_id           uuid references public.recipes(id)             on delete cascade,
  batch_id            uuid references public.brew_batches(id)        on delete cascade,
  sort_order          int  not null default 0,
  activity            text not null,
  time_label          text,
  temp                numeric,
  temp_unit           text not null default 'F',
  amount              numeric,
  amount_unit         text,
  vsp                 numeric,
  created_at          timestamptz not null default now(),
  constraint brew_activities_one_scope check (
    (library_template_id is not null)::int
  + (recipe_id           is not null)::int
  + (batch_id            is not null)::int = 1
  )
);

-- One partial index per scope FK (supports the embeds and cascade deletes).
create index if not exists brew_activities_library_idx
  on public.brew_activities(library_template_id) where library_template_id is not null;
create index if not exists brew_activities_recipe_idx
  on public.brew_activities(recipe_id) where recipe_id is not null;
create index if not exists brew_activities_batch_idx
  on public.brew_activities(batch_id) where batch_id is not null;

-- RLS mirrors the surviving sibling brew_step_templates (authenticated full access).
alter table public.brew_activities enable row level security;
drop policy if exists "Authenticated users can manage brew activities" on public.brew_activities;
create policy "Authenticated users can manage brew activities"
  on public.brew_activities for all to authenticated using (true) with check (true);

-- Audit trigger to match the tables it replaces.
drop trigger if exists audit_brew_activities on public.brew_activities;
create trigger audit_brew_activities
  after insert or update or delete on public.brew_activities
  for each row execute function audit_trigger_fn();

-- Drop the superseded tables (batch log first: its template_id FK targets
-- recipe_brew_activity_templates).
drop table if exists public.batch_brew_activity_log;
drop table if exists public.recipe_brew_activity_templates;
drop table if exists public.brew_step_template_steps;
