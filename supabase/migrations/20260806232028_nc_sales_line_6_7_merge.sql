-- NC DOR Sales & Use: report Modular Homes and Mfg. Homes as one line.
--
-- Both carried the same 4.75% rate and were never separately populated
-- (verified: every stored worksheet had line7_purchases/receipts/tax = 0), so
-- the worksheet now keeps a single "Modular & Mfg. Homes" field triple on
-- line 6 and `RATE_LINES` no longer includes 7.
--
-- Line 6's rate row is renamed to match what it now covers; line 7's is
-- deactivated rather than deleted so historical rate lookups still resolve.

update tax_rates
   set name = 'NC Sales & Use — Line 6 (Modular & Mfg. Homes)',
       updated_at = now()
 where key = 'nc_sales_line_6';

update tax_rates
   set is_active = false,
       updated_at = now()
 where key = 'nc_sales_line_7';
