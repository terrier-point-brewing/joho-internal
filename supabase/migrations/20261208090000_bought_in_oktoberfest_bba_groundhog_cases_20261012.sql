-- Two cases of Oktoberfest and one case of BBA Groundhog cans bought in
-- from an outside party, one-off (2026-10-12).
--
-- One-off DATA migration (no schema changes), owner-directed.
--
-- This beer was not brewed here. It is seated into cold storage as on-hand
-- ONLY — no synthetic canning transfer — so batch produced-volume, the
-- volume ledger and the excise record are untouched. Same rule the 2026-07-04
-- and 2026-08-31 physical counts used for cans found that the ledger never
-- canned. The lots joined are the ones the same beer already sits on, so the
-- taproom sells it down and the Square push counts it exactly like house stock.
--
--   B-020 Oktoberfest   · CBC Oktoberfest - 16oz Labeled Can Case         1 -> 3
--   B-050 BBA Imp Stout · CBC BBA Groundhog Imperial Stout - 12oz Can Case 1 -> 2
--
-- Finance: the purchase itself lands through the normal expense feed
-- (Ramp/Chase); nothing is booked here.
--
-- ⚠️  Guarded: aborts if either lot is not at the count read on 2026-10-12,
--     so a re-run after later activity fails loudly instead of double-adding.

begin;

do $$
begin
  if (select quantity_on_hand from cold_storage_inventory
       where id = 'b03bf489-47fc-4ee8-abe4-7d2b76e58c23') is distinct from 1 then
    raise exception 'B-020 Oktoberfest case lot is not 1 on hand — re-read before applying';
  end if;
  if (select quantity_on_hand from cold_storage_inventory
       where id = 'db5f2d21-bbc8-4d70-b357-77ba85874c79') is distinct from 1 then
    raise exception 'B-050 BBA Groundhog case lot is not 1 on hand — re-read before applying';
  end if;
end $$;

update cold_storage_inventory
   set quantity_on_hand = quantity_on_hand + 2
 where id = 'b03bf489-47fc-4ee8-abe4-7d2b76e58c23';

update cold_storage_inventory
   set quantity_on_hand = quantity_on_hand + 1
 where id = 'db5f2d21-bbc8-4d70-b357-77ba85874c79';

commit;
