-- The brewery premises address, separate from the legal entity's address.
--
-- tax_entity_profile.address_* is the LEGAL ENTITY's address (Raleigh) — what
-- NC DOR and Wake County filings ask for. TTB F 5130.Pilot-B Lines 7b/7c ask
-- for the brewery PREMISES instead, including its county, which the profile
-- had nowhere to hold — so the TTB worksheet was showing the entity address.
--
-- Idempotent: columns are add-if-missing, and the seed only fills a premises
-- that is still entirely blank, so it never overwrites a value edited in
-- Settings → Tax Profile.

alter table public.tax_entity_profile
  add column if not exists premises_address_line1 text,
  add column if not exists premises_address_line2 text,
  add column if not exists premises_city          text,
  add column if not exists premises_county        text,
  add column if not exists premises_state         text,
  add column if not exists premises_postal_code   text;

update public.tax_entity_profile
set premises_address_line1 = '140 Thomas Mill Road',
    premises_city          = 'Holly Springs',
    premises_county        = 'Wake',
    premises_state         = 'NC',
    premises_postal_code   = '27540'
where id
  and premises_address_line1 is null
  and premises_city is null
  and premises_postal_code is null;
