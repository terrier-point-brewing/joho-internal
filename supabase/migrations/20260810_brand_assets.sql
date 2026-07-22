-- Brand assets — uploaded/approved artifacts (logo, wordmark, chop glyph,
-- texture, icon, photo) backed by the public brand-assets Storage bucket.
-- At most one approved row per (kind, variant); admin writes only, public
-- reads of approved assets. Human-gated (do not auto-apply).

create table if not exists public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('logo','wordmark','chop_glyph','texture','icon','photo')),
  variant text not null default 'default',
  storage_path text not null,
  format text not null,
  file_meta jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','approved','archived')),
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

-- at most one approved row per kind+variant
create unique index if not exists brand_assets_one_approved
  on public.brand_assets (kind, variant) where status = 'approved';

alter table public.brand_assets enable row level security;

-- anon SELECT of approved rows only; writes are service-role only (no
-- anon/auth write policy) — admin-gated via requireRole([]) in the API layer.
drop policy if exists brand_assets_read_approved on public.brand_assets;
create policy brand_assets_read_approved on public.brand_assets
  for select using (status = 'approved');

insert into storage.buckets (id, name, public)
values ('brand-assets', 'brand-assets', true)
on conflict do nothing;
