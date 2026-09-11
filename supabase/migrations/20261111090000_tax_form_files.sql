-- Filing-form templates for tax parties: e.g. a partially prefilled B-C-710
-- PDF stored once in Settings → Tax Filing and downloadable from every
-- period's task worksheet. Scoped by party_key (the module/template key,
-- same value as tax_tasks.filing_key), NOT by task — a template is setup,
-- not per-period data. Objects live in the same private tax-confirmations
-- Storage bucket as tax_task_files.
--
-- Also drops tax_task_files.kind if present: an interim iteration of this
-- branch put form files on individual tasks via a kind column before they
-- moved to the party level (that interim state was applied to prod as
-- `tax_task_file_kind`; the drop is a harmless no-op on a fresh replay).

alter table public.tax_task_files drop column if exists kind;

create table if not exists public.tax_form_files (
  id            uuid        primary key default gen_random_uuid(),
  party_key     text        not null,
  storage_path  text        not null,
  file_name     text        not null,
  label         text,
  uploaded_at   timestamptz not null default now(),
  uploaded_by   uuid
);

create index if not exists tax_form_files_party_key_idx
  on public.tax_form_files (party_key);

comment on table public.tax_form_files is
  'filing-form templates (e.g. prefilled return PDFs) per tax party module; objects live in the tax-confirmations Storage bucket';
comment on column public.tax_form_files.party_key is
  'party-template key (= tax_tasks.filing_key) the form belongs to';
comment on column public.tax_form_files.storage_path is
  'object path within the tax-confirmations Storage bucket';

alter table public.tax_form_files enable row level security;

-- Same service-role-only pattern as the rest of the tax module:
-- finance_reader_roles() is empty, so authenticated gets nothing;
-- service_role bypasses RLS.
create policy "finance readers" on public.tax_form_files
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );
