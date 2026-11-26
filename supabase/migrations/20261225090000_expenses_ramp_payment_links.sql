-- Ramp already knows which card charge paid which bill, and which charge a
-- refund reverses. The app threw both away and re-guessed them from amount and
-- date, and in October 2026 the guess tied a $295.83 card charge to the wrong
-- one of two same-amount bills (the card's settlement date sat nine days from
-- the bill it really paid).
--
-- Three columns, all passed straight through from Ramp:
--
--   ramp_payment_method           bill rows. How Ramp paid the bill: CARD, RTP,
--                                 CHECK, ACH, PAID_MANUALLY as seen so far.
--   ramp_payment_transaction_ids  bill rows. When paid by CARD, the Ramp card
--                                 transaction ids that paid it -- each equals
--                                 `source_transaction_id` on a card row.
--   ramp_original_transaction_id  card rows. On a refund, the charge it
--                                 reverses (again a card row's
--                                 `source_transaction_id`).
--
-- Deliberately NO check constraint on ramp_payment_method: it is the vendor's
-- vocabulary, and an enumerated CHECK on a passed-through field breaks
-- ingestion the day Ramp adds a value.
--
-- All nullable and unindexed: null means "Ramp gave no link" (a bank-paid or
-- manually paid bill, an ordinary charge), and the duplicate matcher reads the
-- whole table anyway.
alter table public.expenses
  add column if not exists ramp_payment_method          text,
  add column if not exists ramp_payment_transaction_ids text[],
  add column if not exists ramp_original_transaction_id text;

comment on column public.expenses.ramp_payment_method is
  'Bill rows: how Ramp paid the bill (CARD, RTP, CHECK, ACH, PAID_MANUALLY, ...). Passed through from Ramp; not enumerated.';
comment on column public.expenses.ramp_payment_transaction_ids is
  'Bill rows paid by card: the Ramp card transaction ids that paid it (= source_transaction_id of the card rows).';
comment on column public.expenses.ramp_original_transaction_id is
  'Card refund rows: the Ramp card transaction this refund reverses (= source_transaction_id of the charge).';
