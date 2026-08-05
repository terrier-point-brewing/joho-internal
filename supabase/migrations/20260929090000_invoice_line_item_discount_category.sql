-- Invoice-level discounts get their own line.
--
-- Square allocates an ORDER-scope discount pro-rata into every line's
-- `total_discount_money`, so a flat "$270 off the invoice" arrived here as six
-- fractional slices — including slices carved out of pass-through excise lines,
-- which are remitted in full and must never be discounted.
--
-- The sync now subtracts only LINE_ITEM-scope discounts from a line and writes
-- the invoice-level remainder as one negative `discount` line. That keeps the
-- lines summing to `invoices.total_cents` (so Financials, which sums line rows
-- by account, still ties) while modelling the discount the way it actually
-- reads on the customer's invoice.
--
-- The new line is written UNMAPPED (chart_of_accounts_id null) on purpose: it
-- lands in the Financials "Unmapped" data-quality bucket and a human assigns
-- the contra-revenue account in Finance > Transactions > Invoices, the same way
-- any other unmapped line is handled.

ALTER TABLE invoice_line_items
  DROP CONSTRAINT IF EXISTS invoice_line_items_category_check;

ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_category_check
  CHECK (category = ANY (ARRAY[
    'ingredient_deposit'::text,
    'materials_packaging'::text,
    'packaging_fees'::text,
    'other_services'::text,
    'pass_through_taxes'::text,
    'distribution_keg'::text,
    'distribution_can'::text,
    'discount'::text,
    'other'::text
  ]));
