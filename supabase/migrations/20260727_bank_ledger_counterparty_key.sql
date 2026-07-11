-- Bank-ledger rows currently store only counterparty_name. Auto-mapping resolves
-- an account from expense_counterparty_mappings, which is keyed on the normalized
-- counterparty_key (lowercased/trimmed). Persist that key on each ledger row so the
-- auto-map join is a simple equality, consistent with how expenses store it.
alter table public.ramp_bank_ledger
  add column if not exists counterparty_key text;

-- Backfill existing rows: lower(trim(collapse-whitespace(counterparty_name))), null for empty.
-- Mirrors normalizeCounterparty() in lib/ramp so historical rows resolve the same
-- way freshly-synced rows will. Empty/whitespace-only names normalize to null.
update public.ramp_bank_ledger
   set counterparty_key = nullif(lower(trim(regexp_replace(coalesce(counterparty_name, ''), '\s+', ' ', 'g'))), '')
 where counterparty_key is null;

create index if not exists ramp_bank_ledger_counterparty_key_idx
  on public.ramp_bank_ledger (counterparty_key);
