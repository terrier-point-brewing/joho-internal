-- Invoice-time channel billing override (billing exceptions).
-- Records the channel an invoice was actually BILLED under vs the channel its
-- shipments were SHIPPED under, plus the operator's reason. Nullable so existing
-- and non-override invoices are unaffected. Excise LIABILITY reporting still
-- follows export_transactions.channel — these columns are an invoice/audit trail
-- only. Human-gated (do NOT auto-apply).
alter table public.invoices
  add column if not exists shipped_channel  text,
  add column if not exists billed_channel   text,
  add column if not exists override_reason  text;
