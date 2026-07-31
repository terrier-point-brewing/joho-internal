-- Brand assets: restore the full `kind` set after an out-of-order apply.
--
-- ⚠️ WHY THIS EXISTS
--
-- Two migrations each rewrite `brand_assets_kind_check` from a FULL list rather
-- than adding to it, so whichever runs last wins outright:
--
--   20260810_brand_assets.sql     logo wordmark chop_glyph texture icon photo
--   20260811_brand_labels.sql     … + label_art
--   20260903_brand_assets_private … + font, example   (but NOT label_art —
--                                   20260811 was unapplied when it was written,
--                                   so its list was built from 20260810)
--
-- 20260811 was applied BY HAND on 2026-07-30, after 20260903 had already run.
-- In that order the surviving constraint is 20260811's list, which is missing
-- `font` and `example`. Both are live kinds:
--
--   font    — uploaded typefaces, referenced by brandFontSchema.assetIds and
--             read by app/brand/canon/facets/TypeFacet.tsx
--   example — do/don't imagery, referenced by guideRuleSchema.assetId and read
--             by app/brand/canon/fields/RuleListField.tsx
--
-- So an insert of either now fails a check violation, and BRAND_ASSET_KINDS in
-- lib/brand/assets.ts no longer describes the database.
--
-- THE FIX: state the UNION of every kind any migration has ever declared, so the
-- result no longer depends on apply order. `label_art` is kept — brand_labels
-- exists now, and label artwork scoped to a label / motif family is what it was
-- added for.
--
-- Widening a check constraint cannot invalidate an existing row, so this is safe
-- regardless of which of the three lists is currently in force. Idempotent: the
-- lookup-and-drop tolerates the constraint being absent, present under the
-- explicit name, or present under a generated one.
--
-- Mirrors BRAND_ASSET_KINDS in lib/brand/assets.ts — keep the two in sync.
--
-- Human-gated (do not auto-apply).

-- The constraint may carry a generated name (20260810 created it inline) or the
-- explicit one (20260811 / 20260903). Same defensive lookup as 20260903.
do $$
declare
  target_name text;
begin
  for target_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'brand_assets'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.brand_assets drop constraint %I', target_name);
  end loop;
end $$;

alter table public.brand_assets
  add constraint brand_assets_kind_check
  check (kind in (
    'logo',
    'wordmark',
    'chop_glyph',
    'texture',
    'icon',
    'photo',
    'font',
    'example',
    'label_art'
  ));

-- Verification (expects all nine kinds):
--   select pg_get_constraintdef(oid)
--   from pg_constraint
--   where conname = 'brand_assets_kind_check';
