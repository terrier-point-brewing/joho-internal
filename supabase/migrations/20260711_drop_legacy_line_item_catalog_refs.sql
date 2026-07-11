-- 20260711_drop_legacy_line_item_catalog_refs.sql
-- Follow-up to 20260710: retire the two redundant catalog-ref columns on
-- invoice_line_items now that everything reads/writes square_catalog_variation_id.
-- 20260710 already backfilled square_catalog_variation_id = COALESCE(itself,
-- square_variation_id, square_catalog_object_id), and the last writer of these
-- legacy columns (syncPosTransactions.buildInvoiceLineItems) now writes
-- square_catalog_variation_id. Safe to drop.
--
-- NOTE: pos_line_items keeps its own square_variation_id / square_catalog_object_id
-- columns — those are a different table and are untouched here.

ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS square_variation_id;
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS square_catalog_object_id;
