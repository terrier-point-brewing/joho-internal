-- Retire Safety Stock floors.
--
-- The table held a hand-typed minimum BBL per beer. It never held a row in
-- production (0 rows, 0 audit entries), nothing references it, and Intake now
-- flags a beer automatically one week before it is too late to brew
-- (BUFFER_DAYS in app/production/lib/demandCalendar.ts) instead of relying on
-- a number someone has to maintain.
--
-- Also drops the recurring-commitment columns: nothing has written them since
-- the commitment form lost the fields, every row is one_time, and the last
-- reader (the demand calendar's expandRecurring) is gone.
--
-- Apply AFTER the code that stops reading the table is deployed.

drop table if exists public.safety_stock_floors;

alter table public.commitments
  drop column if exists cadence,
  drop column if exists recurrence,
  drop column if exists start_date,
  drop column if exists end_date;
