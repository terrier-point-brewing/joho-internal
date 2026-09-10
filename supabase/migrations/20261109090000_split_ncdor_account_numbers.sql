-- NC DOR issues separate account numbers for sales & use tax and alcohol
-- excise tax payments. The templates previously shared one registration kind
-- (nc_dor_account_id) so both worksheets rendered the same number; they now
-- declare their own kinds (ncDorSalesUse -> nc_dor_sales_use_account_id,
-- ncDorBeerExcise -> nc_dor_excise_account_id).
--
-- Ordering: apply AFTER the app code that declares the new kinds is deployed.
-- The old kind stays in the CHECK so a not-yet-redeployed app instance can
-- still round-trip its saved rows without a constraint violation.

alter table public.tax_registrations
  drop constraint tax_registrations_registration_kind_check;

alter table public.tax_registrations
  add constraint tax_registrations_registration_kind_check
  check (
    registration_kind is null
    or registration_kind = any (array[
      'fein',
      'abc_permit_number',
      'abc_permit_number_onpremise',
      'nc_dor_account_id',
      'nc_dor_sales_use_account_id',
      'nc_dor_excise_account_id',
      'wake_county_account_id',
      'wake_county_pin',
      'ttb_brewers_notice'
    ])
  );

-- The number on file (6017…) is the sales & use account — E-500 filings have
-- been paid through it. The alcohol excise account number is a new row the
-- operator enters in Settings -> Tax -> Profile.
update public.tax_registrations
set registration_kind = 'nc_dor_sales_use_account_id',
    label = 'NC DOR Sales & Use Account Number'
where authority_key = 'nc_dor'
  and registration_kind = 'nc_dor_account_id';
