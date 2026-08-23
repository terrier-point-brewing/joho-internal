-- Standing GL defaults for a Square catalog scope.
--
-- A bulk map was a one-shot write: it stamped every variation that existed at
-- that moment and remembered nothing. A Square item added the next day landed
-- with a null CoA and showed up as unresolved, even though a person had already
-- declared what that whole category codes to.
--
-- This table is that declaration. Bulk map still fans out over today's rows —
-- the rule is not a view over the mappings, and an individual variation can
-- always be re-pointed by hand afterwards — but it also records the intent, so
-- the catalog sync can apply it to variations it has never seen before.
--
-- One row per scope. The three CoA columns and `excluded` are independently
-- nullable: NULL means "this rule says nothing about that field", which is how a
-- bulk exclude and a bulk map on the same category coexist in one row.

create table if not exists public.square_gl_default_rules (
  id         uuid primary key default gen_random_uuid(),
  -- Which level of the mapping tree this rule governs. Precedence when more
  -- than one matches is item > category > parent — narrowest wins.
  scope      text not null check (scope in ('parent', 'category', 'item')),
  -- parent/category: the Square category id. NULL = the Uncategorized group,
  -- which is a real scope a person can bulk-map, not a missing value.
  -- item: square_catalog_items.id, as text so one column covers both id shapes.
  scope_key  text,
  chart_of_accounts_id         uuid references public.chart_of_accounts(id) on delete cascade,
  chart_of_accounts_id_pos     uuid references public.chart_of_accounts(id) on delete cascade,
  chart_of_accounts_id_invoice uuid references public.chart_of_accounts(id) on delete cascade,
  excluded   boolean,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

comment on table public.square_gl_default_rules is
  'Standing GL default for a Square catalog scope, recorded when a bulk map is applied. The catalog sync applies it to newly-seen variations so a new item inherits the decision already made for its category.';
comment on column public.square_gl_default_rules.scope_key is
  'Square category id for parent/category scopes, square_catalog_items.id for item scope. NULL is meaningful: it is the Uncategorized group.';
comment on column public.square_gl_default_rules.excluded is
  'NULL = this rule says nothing about exclusion. TRUE = new variations in scope are excluded from revenue coding.';

-- A scope has exactly one rule. NULL scope_key needs its own index because
-- NULLs never collide in a plain unique index.
create unique index if not exists square_gl_default_rules_scope_uq
  on public.square_gl_default_rules (scope, scope_key) where scope_key is not null;
create unique index if not exists square_gl_default_rules_scope_null_uq
  on public.square_gl_default_rules (scope) where scope_key is null;

-- public.update_updated_at() is the ONE canonical updated_at trigger, repo-wide.
drop trigger if exists square_gl_default_rules_updated_at on public.square_gl_default_rules;
create trigger square_gl_default_rules_updated_at
  before insert or update on public.square_gl_default_rules
  for each row execute function public.update_updated_at();

alter table public.square_gl_default_rules enable row level security;

-- Matches square_catalog_variations, the table these rules write into. The real
-- gate is CAP.financeTransactionsManage on the routes.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'square_gl_default_rules'
      and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on public.square_gl_default_rules
      for all to authenticated
      using (true)
      with check (true);
  end if;
end $$;
