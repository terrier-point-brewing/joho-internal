-- The NC beer excise task now carries Form B-C-715 (Malt Beverage Shipping
-- Report) alongside the B-C-710 return (PR #632), so its name says so.
-- Kept in step with the party template's label in
-- lib/tax/parties/ncDorBeerExcise/template.ts.

update public.tax_obligations
   set label = 'NC DOR — Beer Excise Tax (B-C-710/715)'
 where key = 'nc_dor_beer_excise';
