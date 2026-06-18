-- Add planned_branch to batch_schedule_entries so split-planning branches can be
-- stored alongside main-branch entries without a separate table.
-- NULL / absent = main (primary) branch.  Non-null = a named planned split branch.
alter table public.batch_schedule_entries
  add column if not exists planned_branch text;
