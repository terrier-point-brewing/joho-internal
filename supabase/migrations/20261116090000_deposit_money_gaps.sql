-- Step 3 of the commitments-chain project: close the money gaps the
-- 2026-09-13 review found.
--
-- 1. A contract shipment can leave before its deposit is paid — the ship
--    route only ever blocked on cold-storage quantity. That stays allowed
--    (the deposit is back-charged on the export invoice), but it is now an
--    explicit, acknowledged act, and the row records it, so the ledger can
--    say which beer moved on credit.
--
-- 2. Invoices had no audit trail and the preview modal lets the operator
--    hand-edit any line. Every generated line that is changed, removed, or
--    added by hand is now recorded on the invoice with a reason, and the
--    invoices cluster gets the same audit trigger the rest of the chain has.

-- ── 1. Shipped before the deposit was paid ───────────────────────────────────
alter table public.export_transactions
  add column if not exists shipped_before_deposit boolean not null default false;

comment on column public.export_transactions.shipped_before_deposit is
  'True when this row credited a contract allocation whose ingredient deposit was not yet paid at ship time (operator acknowledged; deposit back-charges on the export invoice).';

-- ── 2. Invoice line edits, with a reason ─────────────────────────────────────
alter table public.invoices
  add column if not exists line_edit_reason text,
  add column if not exists line_edits jsonb;

comment on column public.invoices.line_edits is
  'Hand edits made in the preview before this invoice was raised: [{kind: changed|removed|added, description, before:{quantity,unitPriceCents}, after:{...}}]. Null when the invoice went out exactly as generated.';
comment on column public.invoices.line_edit_reason is
  'Why the generated lines were edited. Required whenever line_edits is non-empty.';

drop trigger if exists audit_invoices on public.invoices;
create trigger audit_invoices
  after insert or update or delete on public.invoices
  for each row execute function public.audit_trigger_fn();

drop trigger if exists audit_invoice_line_items on public.invoice_line_items;
create trigger audit_invoice_line_items
  after insert or update or delete on public.invoice_line_items
  for each row execute function public.audit_trigger_fn();
