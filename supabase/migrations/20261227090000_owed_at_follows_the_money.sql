-- Receivables and payables are dated by when the money moved, not by when the
-- paperwork said "paid".
--
-- Two timing gaps were the largest items in every month-end balancing
-- difference traced from June to October 2026:
--
--   Partner invoices paid by bank transfer. `invoices.paid_on` is the day the
--   customer STARTED the transfer; the money reaches the Square balance three
--   or four days later. Receivables dropped on the first day and cash rose on
--   the second. 31 October 2026 fell between them for five invoices: $8,669.76.
--
--   Bills Ramp pays by mailed check. Ramp debits the wallet the day it sends
--   the check, and `expenses.settled_at` is the day the vendor cashes it, two
--   or three weeks later. Payables kept a bill the wallet had already paid:
--   $6,690 of rent at 30 June, 31 August and 30 September.
--
-- One new date on each side, both plain calendar days:
--
--   invoices.funds_received_on  the brewery-local day the payment completed
--                               (the Square order's closed_at).
--   expenses.payment_sent_on    bill rows: the day Ramp released the payment
--                               (payment.effective_date). Null for a payment
--                               only scheduled, and for card / manual payments.
--
-- Both are additive and nullable. The as-at rule (lib/finance/balances/
-- owedAt.ts) falls back to paid_on / settled_at when the new date is null, so
-- nothing changes for a row until it has one. `paid_on` and `settled_at` keep
-- their meaning and every other reader of them is untouched.
--
-- Closed months are not restated: their balances are frozen rows.

alter table public.invoices
  add column if not exists funds_received_on date;

comment on column public.invoices.funds_received_on is
  'Brewery-local day the payment completed and the money reached Square (order closed_at). Later than paid_on for a bank transfer. Null when unpaid or unknown. Drives as-at accounts receivable.';

alter table public.expenses
  add column if not exists payment_sent_on date;

comment on column public.expenses.payment_sent_on is
  'Bill rows: the day Ramp released the payment and debited the wallet (payment.effective_date). Can be weeks before settled_at for a mailed check. Null until sent, and for card or manual payments. Drives as-at accounts payable.';

-- Backfill invoices from data already stored: the Square order each invoice was
-- paid through, falling back to the invoice's own last-updated time (the moment
-- Square flipped it to PAID). expenses.payment_sent_on needs no backfill here:
-- the Ramp sync rewrites it for every stored bill on its next run.
update public.invoices i
set funds_received_on = (
  coalesce(
    (select (o.raw_data->>'closed_at')::timestamptz
       from public.square_orders o
      where o.invoice_id = i.id and o.raw_data->>'closed_at' is not null
      order by (o.raw_data->>'closed_at')::timestamptz desc
      limit 1),
    (i.raw_data->>'updated_at')::timestamptz
  ) at time zone 'America/New_York'
)::date
where i.status = 'paid'
  and i.paid_on is not null
  and i.funds_received_on is null;
