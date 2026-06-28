-- Drop the export_channel enum type — orphaned after batch_exports was dropped.
--
-- The enum was created in 20260609_baseline.sql to type the channel column on
-- batch_exports.  batch_exports was dropped in its entirety by
-- 20260622_export_transactions.sql (comment: "green-field/test-only data,
-- confirmed no backfill needed"), which replaced it with the export_transactions
-- table.  export_transactions.channel uses text + CHECK constraint instead of
-- this enum, matching the project-wide convention for categorical columns.
--
-- Confirmed safe:
--   1. No code in app/ or lib/ references the export_channel type.
--   2. No migration after 20260609_baseline.sql references the type (the only
--      column that carried it — batch_exports.channel — was dropped with its table).
--   3. Semantic replacement: text + CHECK on export_transactions.channel,
--      batch_allocations.channel, and commitments.channel.
--
-- No code changes required.

drop type if exists public.export_channel;
