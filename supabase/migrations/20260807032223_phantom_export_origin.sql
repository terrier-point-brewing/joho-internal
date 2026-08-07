-- Phantom export rows record WHAT could not be deducted, never WHY they exist.
--
-- `recordTaproomConsumption` is the shared booking path for all three Square
-- consumption kinds — draft swaps (a Draft Restock ring), keg sales and can
-- sales — and any shortfall against cold storage writes a phantom row through
-- the same `writePhantomExport`. The row that came out carried no trace of
-- which kind produced it, so every consumer downstream had to assume one.
-- Export Bay assumed draft swap: it listed a wholesale keg sale and four can
-- 4-pack sales as "draft swaps recorded without cold-storage stock", and tried
-- to attach a tap number to each.
--
-- `phantom_origin` records the kind at write time. Null on non-phantom rows —
-- a regular shipment has no origin to disambiguate.

alter table public.export_transactions
  add column if not exists phantom_origin text;

alter table public.export_transactions
  drop constraint if exists export_transactions_phantom_origin_check;

alter table public.export_transactions
  add constraint export_transactions_phantom_origin_check
  check (
    phantom_origin is null
    or phantom_origin in ('draft_swap', 'keg_sale', 'can_sale')
  );

comment on column public.export_transactions.phantom_origin is
  'Which Square consumption kind booked this phantom row: draft_swap (a Draft Restock ring), keg_sale or can_sale. Null on non-phantom rows. Set at write time by writePhantomExport.';

-- Backfill. A `sqtransfer:` source_ref is a Draft Restock line item and is the
-- only unambiguous draft-swap marker; everything else is a sale, split into keg
-- vs can by the container the row was booked against. Rows with no
-- packaging_items match are left null rather than guessed at.
update public.export_transactions e
   set phantom_origin = case
         when e.source_ref like 'sqtransfer:%' then 'draft_swap'
         when pi.type = 'keg'                  then 'keg_sale'
         else                                       'can_sale'
       end
  from public.packaging_items pi
 where pi.id = e.packaging_item_id
   and e.is_phantom
   and e.phantom_origin is null;

create index if not exists export_transactions_phantom_origin_idx
  on public.export_transactions (phantom_origin)
  where is_phantom;
