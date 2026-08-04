-- Track catalog objects Square no longer returns.
--
-- `/catalog/list` returns live objects only, and the catalog sync upserts without
-- ever removing, so the mirror accumulates rows for variations that were deleted
-- in Square. Those ghosts read as authoritative: a stale row is how a deleted
-- variation stayed mapped for nine days while every inventory write against it
-- silently went nowhere.
--
-- `synced_at` is already stamped on every upserted row, so a row whose synced_at
-- predates the current sync run is absent from Square. This flag records that
-- rather than deleting the row — the mapping that points at it still needs to be
-- visible so a human can re-point it (set aside, don't delete).

alter table square_catalog_items
  add column if not exists is_deleted boolean not null default false;

alter table square_catalog_variations
  add column if not exists is_deleted boolean not null default false;

comment on column square_catalog_items.is_deleted is
  'True when a full catalog sync did not see this item in Square. The row is kept so mappings pointing at it stay inspectable.';

comment on column square_catalog_variations.is_deleted is
  'True when a full catalog sync did not see this variation in Square. The row is kept so mappings pointing at it stay inspectable.';

-- The hot query is "which live variations exist", run on every reconcile.
create index if not exists square_catalog_variations_live_idx
  on square_catalog_variations (square_variation_id)
  where is_deleted = false;
