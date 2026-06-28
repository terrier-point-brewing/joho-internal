-- Backfills partner_id on all partner-specific packaging_items that were
-- created without it: CBC printed cans + all CBC/Fortnight/Local Time labels + kegs.

with partners as (
  select
    (select id from public.contract_brewing_partners where company_name = 'Argus Beverage Ventures LLC') as argus,
    (select id from public.contract_brewing_partners where company_name = 'Fortnight Brewing')           as ftnight,
    (select id from public.contract_brewing_partners where company_name = 'Local Time Brewing')          as lt
)
update public.packaging_items pi
set partner_id = case
  when pi.name in (
    'CBC Epic Hazy IPA 16oz Can',
    'CBC Hop Roar IPA 16oz Can',
    'CBC Pace Yourself Pilsner 16oz Can',
    'CBC Carolina Pale Ale 16oz Can',
    'CBC Vienna Lager Label',
    'CBC Blackberry Lemon Wheat Label',
    'CBC Spring Bock Label',
    'CBC Watermelon Gose Label',
    'CBC Castle Ruins Brown Ale Label',
    'CBC Be Like Mike IPA Label',
    'CBC Groundhog Imperial Stout Label',
    'CBC BBA Groundhog Imperial Stout Label',
    'CBC Wiggo! IPA Label'
  ) then (select argus from partners)
  when pi.name in (
    'Fortnight 1/2 Keg',
    'Fortnight 1/4 Keg',
    'Fortnight 1/6 Keg',
    'Fortnight Blank Coast IPA Label',
    'Fortnight Mash Pit Lager Label',
    'Fortnight Pumpkin Ale Label'
  ) then (select ftnight from partners)
  when pi.name in (
    'Local Time 1/2 Keg',
    'Local Time 1/4 Keg',
    'Local Time 1/6 Keg',
    'Local Time Vienna Lager Label'
  ) then (select lt from partners)
end
where pi.partner_id is null
  and pi.name in (
    'CBC Epic Hazy IPA 16oz Can','CBC Hop Roar IPA 16oz Can',
    'CBC Pace Yourself Pilsner 16oz Can','CBC Carolina Pale Ale 16oz Can',
    'CBC Vienna Lager Label','CBC Blackberry Lemon Wheat Label',
    'CBC Spring Bock Label','CBC Watermelon Gose Label',
    'CBC Castle Ruins Brown Ale Label','CBC Be Like Mike IPA Label',
    'CBC Groundhog Imperial Stout Label','CBC BBA Groundhog Imperial Stout Label',
    'CBC Wiggo! IPA Label',
    'Fortnight 1/2 Keg','Fortnight 1/4 Keg','Fortnight 1/6 Keg',
    'Fortnight Blank Coast IPA Label','Fortnight Mash Pit Lager Label','Fortnight Pumpkin Ale Label',
    'Local Time 1/2 Keg','Local Time 1/4 Keg','Local Time 1/6 Keg',
    'Local Time Vienna Lager Label'
  );
