-- Wordmark orientation facet.
--
-- A wordmark ships two ways: horizontal (wide placements) or vertical
-- (stacked, narrow placements) — a fourth axis alongside the shape, ink and
-- ground facets added by 20260922090000. Nullable for the same reason those
-- are: meaningless on a non-wordmark kind, and unset on anything uploaded
-- before this migration.
--
-- Human-gated (do not auto-apply).

alter table public.brand_assets
  add column if not exists orientation text
    check (orientation is null or orientation in ('horizontal', 'vertical'));
