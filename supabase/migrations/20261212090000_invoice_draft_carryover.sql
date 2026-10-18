-- What a redrafted Square invoice needs to carry across.
--
-- Editing a line on a Draft export invoice cancels the Square draft and
-- raises a new one from the stored line rows. Two things on the original were
-- never stored, so every edit silently dropped them: the customer-visible note
-- typed at generate, and the per-line catalog discount (the distribution bulk
-- discount). Both now have a home.
alter table public.invoices
  add column if not exists customer_note text;
comment on column public.invoices.customer_note is
  'Customer-visible note sent as the Square invoice description; carried onto every redraft.';

alter table public.invoice_line_items
  add column if not exists square_catalog_discount_id text;
comment on column public.invoice_line_items.square_catalog_discount_id is
  'Square catalog id of the LINE_ITEM-scope discount applied to this line, read back from the order; re-applied on redraft.';
