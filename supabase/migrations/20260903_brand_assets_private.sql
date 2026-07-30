-- Brand assets go private, and gain the kinds + metadata the Brand Guide
-- restructure needs.
--
-- Nothing brand-related is served to unauthenticated users today, so the whole
-- bucket flips to private rather than keeping a public surface nobody uses.
-- When a public marketing site exists it gets its OWN public bucket for the
-- subset that should be exposed, and assets gain a visibility flag choosing
-- between them. That is deliberately not built here.
--
-- ⚠️ ORDERING: apply this only AFTER the commit that adds
-- app/api/brand/assets/[id]/file (assetFileUrl) is deployed. Applying it against
-- code that still builds public storage URLs breaks every brand image at once.
--
-- Human-gated (do not auto-apply).

-- 1. The bucket itself.
update storage.buckets set public = false where id = 'brand-assets';

-- 2. Anonymous reads of the brand_assets TABLE go too. The only consumer was
--    app/brand/guide/page.tsx's cookieless client, now deleted — the /brand
--    tree is session-gated and reads through the service-role admin client.
drop policy if exists brand_assets_read_approved on public.brand_assets;

-- 3. New kinds. A check constraint can't be altered in place, so it is dropped
--    and recreated under an explicit name (the original was created inline and
--    carries a generated name, hence the defensive lookup).
--    Mirrors BRAND_ASSET_KINDS in lib/brand/assets.ts — keep the two in sync.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'brand_assets'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';

  if constraint_name is not null then
    execute format('alter table public.brand_assets drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.brand_assets
  add constraint brand_assets_kind_check
  check (kind in ('logo','wordmark','chop_glyph','texture','icon','photo','font','example'));

-- 4. Human metadata. `alt_text` is required for accessible do/don't imagery on
--    the Visual Identity and Color tabs; `title` names an asset in the library
--    without decoding its storage path.
alter table public.brand_assets
  add column if not exists title text,
  add column if not exists alt_text text;
