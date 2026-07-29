-- Packaging loss % on canning runs + yeast re-pitch on brewhouse assignment.
--
-- 1. batch_transfers.packaging_loss_pct
--    A canning run spoils some cans/lids/labels (mis-fills, mis-labels, seam
--    rejects). The loss applies ONLY to the three per-can components — never to
--    paktechs or trays, which are handled per package, not per can. Stored per
--    transfer so a run that ran unusually clean/dirty keeps its own rate.
--
-- 2. export_transactions.packaging_loss_pct
--    Stamped at ship time from the originating canning run(s) so the
--    "Packaging Materials" invoice line bills the same quantity that was
--    physically consumed. Historical rows stay 0 — they were invoiced without
--    a loss component and must not change retroactively.
--
-- 3. brew_batches.yeast_repitch / yeast_repitch_note
--    A re-pitched batch reuses yeast cropped from a previous batch, so the
--    recipe's yeast line must NOT draw down ingredient stock at turn start.
--    Affects yeast consumption only — deposits, commitments and every other
--    ingredient behave exactly as before.

alter table public.batch_transfers
  add column if not exists packaging_loss_pct numeric not null default 0;

alter table public.export_transactions
  add column if not exists packaging_loss_pct numeric not null default 0;

alter table public.brew_batches
  add column if not exists yeast_repitch boolean not null default false,
  add column if not exists yeast_repitch_note text;

comment on column public.batch_transfers.packaging_loss_pct is
  'Canning packaging loss %, applied to containers/lids/labels only. 0 for kegging and all non-packaging transfers.';
comment on column public.export_transactions.packaging_loss_pct is
  'Packaging loss % inherited from the canning run, applied pro-rata to container/lid/label quantities when billing packaging materials.';
comment on column public.brew_batches.yeast_repitch is
  'When true, the recipe''s Yeast-category ingredients are not consumed at brewhouse turn start (yeast was cropped from a prior batch).';

-- Guard: a loss percentage is a percentage, and a negative one would silently
-- credit inventory back on a canning run.
do $$ begin
  alter table public.batch_transfers
    add constraint batch_transfers_packaging_loss_pct_range
    check (packaging_loss_pct >= 0 and packaging_loss_pct <= 100);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.export_transactions
    add constraint export_transactions_packaging_loss_pct_range
    check (packaging_loss_pct >= 0 and packaging_loss_pct <= 100);
exception when duplicate_object then null;
end $$;
