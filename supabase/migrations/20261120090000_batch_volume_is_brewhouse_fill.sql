-- brew_batches.volume_bbl has one meaning: the brewhouse fill, 20 bbl x turns.
-- It seeds the volume ledger and is the denominator of every allocation
-- percentage, so no client gets to pick it (see lib/production/batchVolume.ts —
-- the 20 here must match BREWHOUSE_BBL there; batchVolume.test.ts checks it).
-- A conversion-born batch never saw the brewhouse: its volume is what the
-- conversion delivered, and is left alone.

-- B-042 was logged as 1 turn but brewed as 2 (40 bbl in, ~37 packaged).
-- Turns only; its ingredient consumption is a separate human decision.
update public.brew_batches
set turns = 2
where batch_number = 'B-042' and turns = 1 and volume_bbl = 40;

create or replace function public.brew_batches_derive_volume()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.converted_from_batch_id is null then
    new.volume_bbl := 20 * greatest(coalesce(new.turns, 1), 1);
  end if;
  return new;
end;
$$;

drop trigger if exists brew_batches_derive_volume on public.brew_batches;
create trigger brew_batches_derive_volume
  before insert or update of volume_bbl, turns on public.brew_batches
  for each row execute function public.brew_batches_derive_volume();
