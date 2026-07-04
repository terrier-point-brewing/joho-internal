-- Over-allocation flag on export shipments.
--
-- When a contract-brewing partner is shipped MORE beer than their deposit booked
-- (and no soft allocation absorbs the excess), the surplus is recorded as its own
-- un-allocated export row rather than inflating an allocation past 100%. This flag
-- marks those rows so finance can decide at invoice time to bill the extra as
-- product or gift it (see the allocation-reserve plan, decision 3).
--
-- Additive and nullable-default — historical rows read as false. Safe to re-run.

alter table public.export_transactions
  add column if not exists over_allocation boolean not null default false;

-- Reporting: quickly find over-delivered shipments.
create index if not exists export_transactions_over_allocation_idx
  on public.export_transactions(over_allocation)
  where over_allocation;
