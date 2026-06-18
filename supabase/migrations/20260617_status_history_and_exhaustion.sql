-- Fix 6: Add changed_by to batch_status_history so every status event records
-- the actor first-class (audit_log captures it too, but this makes it queryable
-- without joining audit_log).
alter table public.batch_status_history
  add column if not exists changed_by uuid references auth.users(id) on delete set null;

create index if not exists bsh_changed_by_idx on public.batch_status_history(changed_by);

-- Also add changed_by to the internal RPC insert that fires on tank assignment.
-- The RPC record_batch_transfer already records the actor in batch_transfers;
-- status history written by the RPC uses a separate trigger path and cannot
-- accept a session variable easily, so we leave those rows with changed_by=null
-- (they are still fully covered by audit_log).  Application-layer inserts
-- (batches/[id], tank-assignments, conversions) will supply changed_by directly.

-- Fix 8: Batch exhaustion view — per-batch summary of how much volume has been
-- consumed vs the original brew volume.  A batch is "exhausted" when
-- consumed_bbl >= original_volume_bbl.
--
-- Consumed = kegged + canned + exported + converted_out + shrinkage.
-- "Converted out" = volume that left this batch via a conversion transfer
-- (to_batch_id IS NOT NULL) — it belongs to the child batch from here on.

create or replace view public.batch_exhaustion as
select
  b.id                                          as batch_id,
  b.batch_number,
  b.beer_name,
  b.status,
  b.volume_bbl                                  as original_volume_bbl,

  -- volume kegged (transfer_type = 'kegging')
  coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'kegging'),           0) as kegged_bbl,

  -- volume canned (transfer_type = 'canning')
  coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'canning'),           0) as canned_bbl,

  -- volume exported (destination is export_bay or loading_bay)
  coalesce(sum(t.volume_bbl) filter (
    where eq_to.type in ('export_bay', 'loading_bay')
    and   t.to_batch_id is null
  ), 0)                                                                               as exported_bbl,

  -- volume converted to a child batch
  coalesce(sum(t.volume_bbl) filter (where t.to_batch_id is not null),             0) as converted_bbl,

  -- total shrinkage across all transfers
  coalesce(sum(t.shrinkage_bbl), 0)                                                   as shrinkage_bbl,

  -- total consumed
  coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'kegging'),           0)
  + coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'canning'),         0)
  + coalesce(sum(t.volume_bbl) filter (
      where eq_to.type in ('export_bay', 'loading_bay') and t.to_batch_id is null
    ), 0)
  + coalesce(sum(t.volume_bbl) filter (where t.to_batch_id is not null),           0)
  + coalesce(sum(t.shrinkage_bbl), 0)                                                 as consumed_bbl,

  -- remaining = original minus consumed (may be negative if data error)
  b.volume_bbl - (
    coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'kegging'),         0)
    + coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'canning'),       0)
    + coalesce(sum(t.volume_bbl) filter (
        where eq_to.type in ('export_bay', 'loading_bay') and t.to_batch_id is null
      ), 0)
    + coalesce(sum(t.volume_bbl) filter (where t.to_batch_id is not null),         0)
    + coalesce(sum(t.shrinkage_bbl), 0)
  )                                                                                   as remaining_bbl,

  -- exhausted when remaining ≤ 0.001 (floating-point tolerance)
  (b.volume_bbl - (
    coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'kegging'),         0)
    + coalesce(sum(t.volume_bbl) filter (where t.transfer_type = 'canning'),       0)
    + coalesce(sum(t.volume_bbl) filter (
        where eq_to.type in ('export_bay', 'loading_bay') and t.to_batch_id is null
      ), 0)
    + coalesce(sum(t.volume_bbl) filter (where t.to_batch_id is not null),         0)
    + coalesce(sum(t.shrinkage_bbl), 0)
  )) <= 0.001                                                                         as is_exhausted

from public.brew_batches b
left join public.batch_transfers t
       on t.batch_id = b.id
left join public.equipment eq_to
       on eq_to.id = t.to_tank_id
group by b.id, b.batch_number, b.beer_name, b.status, b.volume_bbl;
