-- Top-up for tables that gain an `updated_at` column after the canonical
-- trigger migration (20261001090000) has already run.
--
-- This was not hypothetical: `tax_obligations` was created by a concurrent
-- migration minutes after the canonical pass, and arrived with the column and
-- nothing behind it -- reintroducing on day one exactly the drift that
-- migration existed to remove.
--
-- Written to be re-runnable. It creates a trigger only where one is missing, so
-- it is safe to apply again whenever the coverage assertion below starts to
-- fail. If that happens often, the durable fix is an event trigger on
-- CREATE/ALTER TABLE rather than repeated top-ups.
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
       and not exists (
         select 1
           from pg_trigger tg
           join pg_proc p on p.oid = tg.tgfoid
          where tg.tgrelid = c.oid
            and not tg.tgisinternal
            and p.proname = 'update_updated_at'
       )
     order by c.relname
  loop
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.update_updated_at()',
      r.tbl || '_updated_at', r.tbl
    );
    raise notice 'backfilled trigger %_updated_at', r.tbl;
  end loop;
end;
$$;

-- Same assertion as the canonical migration: every table with the column has
-- exactly one trigger driving it.
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
