-- Brand labels — each beer as a story title + plain-style subtitle, motif
-- family, earned Tier-2 palette, 5-criteria naming check, and an assigned chop
-- glyph. Also lands the deferred brand_assets label columns + the label_art
-- kind (assets can now scope to a label / motif family). Human-gated (do not
-- auto-apply).

create table if not exists public.brand_labels (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- story title
  subtitle text,                         -- plain-style subtitle
  description text,
  motif_family text,
  status text not null default 'draft'
    check (status in ('draft','approved','archived')),
  tier2_palette jsonb not null default '{"colors":[]}'::jsonb,
  naming_check jsonb not null default '{"results":[]}'::jsonb,
  chop_glyph_asset_id uuid references public.brand_assets(id) on delete set null,
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

alter table public.brand_labels enable row level security;
drop policy if exists brand_labels_read_approved on public.brand_labels;
create policy brand_labels_read_approved on public.brand_labels
  for select using (status = 'approved');   -- writes are service-role only

-- brand_assets: land the deferred label columns + widen kind for label_art
alter table public.brand_assets
  add column if not exists label_id uuid references public.brand_labels(id) on delete set null,
  add column if not exists motif_family text;

alter table public.brand_assets drop constraint if exists brand_assets_kind_check;
alter table public.brand_assets add constraint brand_assets_kind_check
  check (kind in ('logo','wordmark','chop_glyph','texture','icon','photo','label_art'));
