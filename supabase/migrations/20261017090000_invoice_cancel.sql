-- Cancelling an export invoice.
--
-- Two records the cancel path needs and the schema did not have:
--
--  1. `invoice_sku_substitutions.reversed_at` — a substitution credit paid Square
--     back for units it deducted against a BORROWED item. Cancelling the invoice
--     unmakes that deduction, so the standing credit leaves Square over-counted
--     by exactly the credited quantity and has to be taken out again. This is the
--     once-only guard for that removal, mirroring `restored_at` for the credit
--     itself. A row can only be reversed if it was restored, which is asserted
--     below rather than left to the caller.
--
--  2. `invoices.voided_reason` / `voided_at` — an operator's stated reason for
--     killing an invoice, kept on the invoice rather than in an audit row because
--     the Export Invoices panel renders it next to the Voided badge.

alter table public.invoice_sku_substitutions
  add column if not exists reversed_at timestamptz,
  add column if not exists reverse_error text;

comment on column public.invoice_sku_substitutions.reversed_at is
  'When the Square credit recorded in restored_at was taken back out, because the invoice that caused the original deduction was cancelled. Null means the credit still stands. Once-only guard for removeStock.';

comment on column public.invoice_sku_substitutions.reverse_error is
  'Why the reversal did not land, when it did not. Mirrors restore_error: Square accepts a write against an object it does not have without erroring, so a reversal is only believed once the count is read back.';

-- A credit that never landed cannot be taken back out. Without this the cancel
-- path could remove units from Square that it never added.
alter table public.invoice_sku_substitutions
  drop constraint if exists invoice_sku_substitutions_reversed_requires_restored;
alter table public.invoice_sku_substitutions
  add constraint invoice_sku_substitutions_reversed_requires_restored
  check (reversed_at is null or restored_at is not null);

alter table public.invoices
  add column if not exists voided_at timestamptz,
  add column if not exists voided_reason text;

comment on column public.invoices.voided_at is
  'When this invoice was cancelled. Set by the Cancel Invoice action; a void discovered by reconcileInvoiceStatus (a cancel done in the Square dashboard) leaves it null, which is how the two are told apart.';

comment on column public.invoices.voided_reason is
  'The operator''s stated reason for cancelling. Required by the Cancel Invoice action, null for a void discovered from Square.';
