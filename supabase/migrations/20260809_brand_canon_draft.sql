-- Brand canon draft support: an editable working draft (at most one at a time)
-- with an updated_at stamp. Builds on 20260808_brand_canon_versions. The
-- canonWorkflow (saveDraft/publishDraft) writes updated_at and relies on the
-- one-draft index to keep a single working draft row.
--
-- Human-gated (do not auto-apply).

alter table public.brand_canon_versions
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists brand_canon_one_draft
  on public.brand_canon_versions ((status)) where status = 'draft';
