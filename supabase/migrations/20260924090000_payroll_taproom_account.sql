-- The one wage GL account whose staff the app can independently verify.
--
-- payroll_entries only ever covers employees with Square shifts (the taproom
-- crew). Every other wage bucket in an uploaded Gusto report -- salaried
-- brewers, admin -- has no shift evidence behind it, so the app can display
-- those figures but must never fold them into an app-vs-Gusto variance.
-- Declaring the account here is what lets getPeriodSummaries split Gusto's
-- wage buckets into "checked" and "shown".
alter table public.payroll_gl_settings
  add column if not exists taproom_chart_of_accounts_id uuid
    references public.chart_of_accounts(id);

-- Backfill to the department the app's payroll entries have always covered.
-- Left null when that mapping doesn't exist -- an unset account means the
-- taproom check reads "not configured", never a wrong number.
update public.payroll_gl_settings s
set taproom_chart_of_accounts_id = m.chart_of_accounts_id
from public.payroll_department_gl_mappings m
where s.taproom_chart_of_accounts_id is null
  and m.department_name = 'Front of House';
