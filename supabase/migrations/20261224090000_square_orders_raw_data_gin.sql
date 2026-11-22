-- GL 2410's "gift cards spent" step finds orders paid with a gift card by
-- containment on the raw Square payload:
--
--   raw_data @> '{"tenders":[{"type":"SQUARE_GIFT_CARD"}]}'
--
-- With no index that is a sequential scan that de-TOASTs every order's payload
-- to find a handful of rows (6 of 5,133 in November 2026). It ran ~1.3s warm
-- and crossed the 8s API statement timeout on 8 of 22 nightly balance-close
-- runs for October 2026. A failed step is a snapshot error, and a snapshot
-- error refuses a period close -- so the Close button intermittently refused
-- for a reason nobody could act on.
--
-- jsonb_path_ops is the smaller, faster GIN class and supports exactly the
-- operator this query uses (@>).
create index if not exists square_orders_raw_data_gin
  on public.square_orders
  using gin (raw_data jsonb_path_ops);
