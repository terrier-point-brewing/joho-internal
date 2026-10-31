-- A Draft Restock nobody rang, inferred from the pours and booked by the sync.
--
-- When the pours between one tap's rings add up to more than a keg, a keg went
-- on in between with no ring. The sync now books that keg (an export row off
-- the same tap and keg size, placed at the pour that blew the one before it)
-- and writes a draft_swap_shrinkage row for it with cause 'missed_ring'. Its
-- pours equal a keg by construction, so unaccounted_fl_oz is 0 and the row is
-- an audit record, not a measurement — the readers leave it out of averages the
-- same way they leave out beer_change.

alter table public.draft_swap_shrinkage
  drop constraint if exists draft_swap_shrinkage_cause_chk;

alter table public.draft_swap_shrinkage
  add constraint draft_swap_shrinkage_cause_chk
  check (cause in ('keg_emptied', 'beer_change', 'missed_ring'));

comment on column public.draft_swap_shrinkage.cause is
  'keg_emptied = keg blew, the balance is true shrinkage (foam, giveaways, line cleaning). beer_change = keg pulled early to change beers, so the balance is dominated by a deliberate dump and does not belong in a shrinkage average. missed_ring = a restock nobody rang, inferred from pours and booked by the sync; always 0 and never averaged.';
