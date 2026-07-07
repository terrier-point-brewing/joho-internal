# Plan — Consolidate brew step/activity tables into `brew_activities`

Schema-audit track #2 (Option A). Collapse three near-identical "step/activity"
tables into one, keeping `brew_step_templates` (the named library parent) as the
only distinct entity. All three source tables are **0 rows**, so this is a clean
cut-over with **no data migration**.

## Current state (the duplication)

Three tables share an identical payload (`sort_order, activity, time_label, temp,
temp_unit, amount, amount_unit, vsp`), differing only in parent FK — a one-way
copy chain `library template → per-recipe default → per-batch log`:

| Table | Parent | Role |
|---|---|---|
| `brew_step_template_steps` | `brew_step_templates(id)` | steps of a reusable library template |
| `recipe_brew_activity_templates` | `recipes(id)` | a recipe's default activities |
| `batch_brew_activity_log` | `brew_batches(id)` | a batch's actual log (+ unused `template_id` lineage) |

Three near-identical route files, three local/exported types, zero tests.

## Target

Keep `brew_step_templates` (`id, name, description`). Replace the three step
tables with one:

```sql
create table public.brew_activities (
  id                  uuid primary key default gen_random_uuid(),
  -- exactly one scope FK is set per row:
  library_template_id uuid references brew_step_templates(id) on delete cascade,
  recipe_id           uuid references recipes(id)             on delete cascade,
  batch_id            uuid references brew_batches(id)        on delete cascade,
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
-- one partial index per scope FK
create index brew_activities_library_idx on brew_activities(library_template_id) where library_template_id is not null;
create index brew_activities_recipe_idx  on brew_activities(recipe_id)           where recipe_id is not null;
create index brew_activities_batch_idx   on brew_activities(batch_id)            where batch_id is not null;
-- RLS mirrors brew_step_templates (authenticated full access)
alter table brew_activities enable row level security;
create policy "Authenticated users can manage brew activities"
  on brew_activities for all to authenticated using (true) with check (true);
-- audit trigger to match the tables it replaces
create trigger audit_brew_activities after insert or update or delete
  on brew_activities for each row execute function audit_trigger_fn();

drop table brew_step_template_steps;
drop table recipe_brew_activity_templates;   -- drops batch_brew_activity_log.template_id FK's target
drop table batch_brew_activity_log;
```
Dropped: the unused `template_id` lineage (written on batch creation, never read).

## Reads — alias the embed to keep the frontend stable

`brew_activities` has exactly one FK to each parent, so PostgREST embeds resolve
unambiguously. Alias the embedded resource so the JSON keys the UI already uses
do not change:

- recipes routes: `...recipe_brew_activity_templates:brew_activities(*)` → key stays `recipe_brew_activity_templates`
- batches routes: `...batch_brew_activity_log:brew_activities(*)` → key stays `batch_brew_activity_log`
- brew-step-templates GET: `...brew_step_template_steps:brew_activities(*)` → key stays `brew_step_template_steps`

Result: read-side types (`RecipeBrewActivityTemplate`, `BrewActivityEntry`) and
UI field access are unchanged.

## Writes — one parameterized route

Replace the three write routes with `app/api/production/brew-activities/route.ts`:
- `POST`/`PATCH`/`DELETE`, `requireRole(["brewer"])`, shared `parseStep` coercion.
- Body carries `scope: "library" | "recipe" | "batch"` + the parent id; the
  handler sets the matching FK. `brew-step-templates` route keeps its
  parent (name/description) CRUD but writes/reads steps through `brew_activities`.

Delete `recipe-brew-activity-templates/route.ts` and `brew-activity-log/route.ts`.

## Touch list

- **Migration**: `supabase/migrations/20260719_brew_activities_consolidation.sql`
- **Routes**: new `brew-activities/route.ts`; edit `brew-step-templates/route.ts` + `[id]`; edit embeds in `recipes/route.ts`, `recipes/[id]`, `batches/route.ts`, `batches/[id]`; edit the recipe→batch seed in `batches/route.ts`; delete the two old write routes.
- **UI**: `RecipesTab.tsx` (loadFromTemplate + recipe-activity save), `BrewStepTemplatesTab.tsx` (library CRUD + ApplyModal), `BatchLogTab.tsx` (BrewActivityLogManager).
- **Types/keys**: `types.ts` (unify local step types; keep read types), `query-keys.ts`.
- **Docs**: `docs/ui/ROUTE_MANIFEST.md`, `docs/production-schema.md`.
- **Tests**: add coverage for the seed/copy pipeline (currently zero).

## Verification
`npx tsc --noEmit`, `npx eslint`, `npx vitest run` all green before commit.

## Risk / rollback
0 rows everywhere → no backfill; drop is reversible by re-creating the three
tables. Main risk is PostgREST embed aliasing + the write-route payload change in
three UIs — covered by typecheck + new tests. RLS mirrors the existing sibling.
