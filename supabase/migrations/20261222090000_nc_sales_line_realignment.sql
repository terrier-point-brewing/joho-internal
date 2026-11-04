-- NC DOR Sales & Use: realign the Form E-500 rate lines.
--
-- After the Modular/Mfg. Homes merge the lines below 6 were numbered one too
-- high. On the current E-500: 7 = 2% Food, 8 = 2% County, 9 = 2.25% County,
-- 10 = 0.5% Transit, 11 = 0.25% Transit, 12 = 1% Additional County (new),
-- 13 = total state and county tax (unchanged).
--
-- Rate rows keep their keys and take the rate the line now carries; the
-- inactive `nc_sales_line_7` (Mfg. Homes) becomes the 2% Food line.
-- Stored worksheets are re-keyed the same way (descending so nothing is
-- overwritten mid-shift) and given an empty line 12 triple.

update tax_rates set name = 'NC Sales & Use — Line 7 (2% Food Rate)',             rate = 0.02,   is_active = true, updated_at = now() where key = 'nc_sales_line_7';
update tax_rates set name = 'NC Sales & Use — Line 8 (2% County Rate)',           rate = 0.02,   updated_at = now() where key = 'nc_sales_line_8';
update tax_rates set name = 'NC Sales & Use — Line 9 (2.25% County Rate)',        rate = 0.0225, updated_at = now() where key = 'nc_sales_line_9';
update tax_rates set name = 'NC Sales & Use — Line 10 (0.5% Transit County Rate)', rate = 0.005,  updated_at = now() where key = 'nc_sales_line_10';
update tax_rates set name = 'NC Sales & Use — Line 11 (0.25% Transit County Rate)', rate = 0.0025, updated_at = now() where key = 'nc_sales_line_11';
update tax_rates set name = 'NC Sales & Use — Line 12 (1% Additional County Rate)', rate = 0.01,   updated_at = now() where key = 'nc_sales_line_12';

update tax_tasks t
   set worksheet = jsonb_set(
     t.worksheet,
     '{fields}',
     (
       select jsonb_object_agg(
                case
                  when k ~ '^line(8|9|10|11|12)_(purchases|receipts|tax)$'
                    then 'line' || (substring(k from '^line(\d+)_')::int - 1) || substring(k from '^line\d+(_.*)$')
                  else k
                end,
                v)
         from jsonb_each(t.worksheet->'fields') e(k, v)
     ) || '{"line12_purchases": 0, "line12_receipts": 0, "line12_tax": 0}'::jsonb
   )
  from tax_schedules s
 where s.id = t.schedule_id
   and s.filing_key = 'nc_dor_sales_use'
   and t.worksheet ? 'fields'
   and t.worksheet->'fields' ? 'line9_tax';
