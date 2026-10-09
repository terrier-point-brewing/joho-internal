-- The day an invoice was paid, so receivables can be asked about a past date.
--
-- GL 1100 was computed as "invoices whose status is open", which is how things
-- stand TODAY. A month end's receivables therefore shrank as the following
-- month's payments arrived, and every close from May 2026 on was rescued by
-- typing the true figure in by hand. With a paid date the same question has a
-- stable answer: invoiced on or before the month end, and not yet paid by it.
--
-- A DATE in the brewery's own calendar, not a timestamp: the only comparison
-- ever made is against a month end, and that is a local-calendar question.
-- Written by the Square invoice sync and the invoice-status reconcile from the
-- order's tender time (when the customer paid), NOT the invoice's updated_at,
-- which only moves when a bank transfer settles days later.
--
-- Null means "not paid", or "paid, date unknown" for imported history the
-- Square sync does not own; the receivables calculation treats the latter as
-- settled before any month end.

alter table public.invoices
  add column if not exists paid_on date;

comment on column public.invoices.paid_on is
  'Brewery-local day the customer paid (Square order tender time). Null when unpaid, or when paid with no known date. Drives as-at accounts receivable.';
