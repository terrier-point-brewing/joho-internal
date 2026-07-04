-- Allocation write-off: forgive the remaining owed volume on a batch_allocation
-- and treat it as fulfilled. Used to close out a contract/soft allocation that
-- fell short (an under-yielded batch, beer shipped elsewhere, etc.). This is a
-- bookkeeping decision only — NO refund is issued (refunds remain the
-- allocations/[id]/adjust percentage-reduction flow). Additive + nullable, so
-- historical rows read as "not written off".

alter table public.batch_allocations
  add column if not exists written_off_at  timestamptz,
  add column if not exists written_off_bbl numeric,
  add column if not exists write_off_note  text;

comment on column public.batch_allocations.written_off_at is
  'When set, the remaining owed volume on this allocation was forgiven and the allocation is treated as fulfilled. Advisory bookkeeping — no refund is issued.';
comment on column public.batch_allocations.written_off_bbl is
  'Snapshot of the BBL still owed (entitlement − exported) at the moment of write-off.';
comment on column public.batch_allocations.write_off_note is
  'Optional operator note explaining why the remaining volume was written off.';
