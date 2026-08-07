-- One canonical updated_at trigger, applied to every table that has the column.
--
-- Before this migration `updated_at` was maintained four different ways:
--
--   update_updated_at()              7 tables  (baseline; the de-facto house one)
--   set_expense_updated_at()         5 tables  (born as set_ramp_updated_at)
--   set_updated_at()                 2 tables  (invoices)
--   set_payroll_entries_updated_at() 1 table   (payroll)
--
-- All four bodies are byte-identical in effect — `new.updated_at = now()` — so
-- collapsing them drops no behaviour. There is no column-change guard and no
-- "don't clobber an explicitly supplied value" escape hatch in any of them, and
-- this migration does not add one: the whole point is that the row's write time
-- is the database's fact to state, not the caller's.
--
-- The remaining 22 tables carried the column with nothing behind it, so their
-- timestamps were only as current as whichever app code path remembered to set
-- one. Those explicit `updated_at:` assignments are removed in the same change;
-- see the PR. `batch_schedule_entries` is one of the 22 — it was missing from
-- the audit that prompted this work, but it has the column, has no trigger, and
-- is written by the production transfer/tank-assignment routes, so it belongs.
--
-- The canonical trigger fires BEFORE INSERT OR UPDATE, not UPDATE only like the
-- four it replaces. Firing on insert too means the column no longer depends on
-- each table having got its `default now()` right, which makes deleting the
-- app-side assignments unconditionally safe — including the insert branch of
-- every upsert (square_orders, square_refunds, invoice_item_mappings, the tax
-- profile tables). Nothing in the codebase writes a backdated `updated_at`, so
-- there is no caller whose intent this overrides.
--
-- OUT OF SCOPE, recorded here so it is not lost: 12 of these tables have
-- `updated_at` but no `created_at` at all — balance_sheet_account_sources,
-- draft_pour_consumption, role_permission_grants, system_settings,
-- tap_assignments, taproom_recipe_settings, tax_authorities, tax_bank_account,
-- tax_entity_profile, tax_filing_profiles, tax_legal_representative,
-- tax_registrations. Adding creation timestamps is a separate change.

-- ── 1. The canonical function ────────────────────────────────────────────────
-- Keeps the existing name and signature so the 7 triggers already pointing here
-- keep working through the replace. `security invoker` (the default) is
-- deliberate: the trigger must not widen anyone's rights.
create or replace function public.update_updated_at()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.update_updated_at() is
  'Canonical updated_at trigger. BEFORE INSERT OR UPDATE on every table with the column. Do not add siblings.';

-- ── 2. Drop the existing triggers, whatever they happen to be named ──────────
-- Driven off pg_catalog rather than a hand-written list of trigger names: the
-- names drifted from their tables during the ramp_* → expense_* renames, so
-- matching on the function they call is the only reliable handle.
do $$
declare
  r record;
begin
  for r in
    select n.nspname as sch, c.relname as tbl, tg.tgname as trg
      from pg_trigger   tg
      join pg_class     c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc      p on p.oid = tg.tgfoid
     where not tg.tgisinternal
       and n.nspname = 'public'
       and p.proname in (
             'update_updated_at',
             'set_updated_at',
             'set_expense_updated_at',
             'set_payroll_entries_updated_at'
           )
  loop
    execute format('drop trigger %I on %I.%I', r.trg, r.sch, r.tbl);
    raise notice 'dropped trigger %.% -> %', r.sch, r.tbl, r.trg;
  end loop;
end;
$$;

-- ── 3. One trigger per table, uniformly named ────────────────────────────────
-- Every public table that actually has an `updated_at` column gets exactly one,
-- named <table>_updated_at. Driven off the catalog so a table added later with
-- the column is caught by re-running this block rather than by remembering.
do $$
declare
  r record;
begin
  for r in
    select c.relname as tbl
      from pg_class     c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where c.relkind  = 'r'
       and n.nspname  = 'public'
       and a.attname  = 'updated_at'
       and a.attnum   > 0
       and not a.attisdropped
     order by c.relname
  loop
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.update_updated_at()',
      r.tbl || '_updated_at', r.tbl
    );
    raise notice 'created trigger %_updated_at', r.tbl;
  end loop;
end;
$$;

-- ── 4. Retire the duplicates ─────────────────────────────────────────────────
-- Safe now that step 2 removed every trigger that referenced them. Plain `drop`
-- rather than `drop ... cascade`: if something outside this migration still
-- depends on one of these, the migration should fail loudly, not silently
-- delete whatever that dependency was.
drop function if exists public.set_updated_at();
drop function if exists public.set_expense_updated_at();
drop function if exists public.set_payroll_entries_updated_at();

-- ── 5. Assert the end state ──────────────────────────────────────────────────
-- Cheap insurance that this actually landed on every table, rather than on
-- whatever subset the catalog happened to return.
do $$
declare
  n_cols int;
  n_trgs int;
begin
  select count(*) into n_cols
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
   where c.relkind = 'r' and n.nspname = 'public'
     and a.attname = 'updated_at' and a.attnum > 0 and not a.attisdropped;

  select count(*) into n_trgs
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
   where not tg.tgisinternal and n.nspname = 'public'
     and p.proname = 'update_updated_at';

  if n_cols <> n_trgs then
    raise exception 'updated_at coverage mismatch: % tables with the column, % triggers', n_cols, n_trgs;
  end if;

  raise notice 'updated_at: % tables, % triggers, 1 function', n_cols, n_trgs;
end;
$$;
