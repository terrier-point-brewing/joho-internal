-- Keg cleaning is charged per partner. Until now every partner's export invoice
-- carried a Keg Cleaning line whenever kegs shipped; a partner who cleans their
-- own kegs could only have it waived by hand on each invoice.
alter table public.contract_brewing_partners
  add column if not exists charges_keg_cleaning boolean not null default true;

comment on column public.contract_brewing_partners.charges_keg_cleaning is
  'When false, export invoices for this partner omit the Keg Cleaning line.';
