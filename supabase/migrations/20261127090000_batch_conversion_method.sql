-- How a conversion physically happens, recorded on the plan/record itself.
--
--   tank        — beer moves into a vessel, is dosed there, conditions, then is
--                 packaged. The child's schedule is conditioning → packaging.
--   in_package  — the dose goes straight into each keg/can as the source is
--                 packaged; no vessel in between. The child's schedule is the
--                 one packaging run on the station, nothing upstream.
--
-- Before this column the two were indistinguishable on a PLAN (both only had a
-- target batch), so a planned in-keg conversion was seeded with a phantom
-- conditioning tank and the Equipment Schedule could not draw it.

alter table public.batch_conversions
  add column if not exists method text not null default 'tank'
    check (method in ('tank', 'in_package'));

-- Executed in-keg runs are identifiable by the provenance the transfers route
-- keeps on the source's conversion row (B-056 → B-063, B-057 → B-064).
update public.batch_conversions bc
   set method = 'in_package'
 where exists (
   select 1 from public.batch_transfers t
    where t.batch_id = bc.source_batch_id
      and t.to_batch_id = bc.target_batch_id
      and t.transfer_type = 'conversion'
      and t.packaged_as_recipe_id is not null
 );
