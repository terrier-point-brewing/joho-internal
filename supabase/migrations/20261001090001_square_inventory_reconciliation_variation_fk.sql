-- The one Square text id that can safely carry a foreign key.
--
-- An audit on 2026-08-07 found seven text columns holding Square ids that are
-- referentially clean — all seven target a UNIQUE column and all seven have zero
-- orphans in production, re-confirmed before this migration was written. Clean
-- data is necessary for an FK and is not sufficient for one: it says the rows
-- line up today, not that the code is ALLOWED to write a child before its
-- parent exists. Six of the seven are written by paths that deliberately do
-- exactly that, and an FK would convert a designed degradation into a failed
-- sync. Only this one is safe.
--
-- WHY THIS ONE IS SAFE. square_inventory_reconciliations rows are written by
-- reconcileSquareCanInventory (lib/production/reconcileSquareCanInventory.ts),
-- which resolves its base variation by reading square_catalog_variations
-- directly and filtering on track_inventory — a mirror column. The parent row
-- is therefore not merely present, it is where the value came from. The insert
-- happens only after the Square write has been read back and verified, so there
-- is no path that reaches it with an unmirrored id.
--
-- WHY NOT THE OTHER SIX — the ordering is inverted by design in each case:
--
--   pos_line_item_taxes.square_tax_id, invoice_line_item_taxes.square_tax_id
--     square_tax_accounts SEEDS ITSELF FROM THESE TABLES. listSalesTaxAccounts
--     (lib/finance/salesTaxAccounts.ts) reads the distinct tax ids observed in
--     the two tax tables and inserts any it has not seen, with a null account,
--     so "a tax that starts appearing in Square shows up in settings with a
--     null account instead of being silently dropped from the balance sheet".
--     The child is the source of the parent. An FK reverses that: the first new
--     Square tax id would fail the POS sync's insert instead of surfacing for a
--     human. square_tax_accounts holds two rows and is otherwise hand-curated,
--     so this is not hypothetical.
--
--   recipe_square_links.square_variation_id / .square_item_id
--     ensureCatalogItemMirrored (lib/square/ensureCatalogItem.ts) pulls the
--     linked item into the mirror when a link is saved, but is BEST EFFORT BY
--     DESIGN: "A link save must never fail because Square was unreachable — the
--     link itself is still correct, and the next full sync will pick the item
--     up." An FK makes Square's availability a precondition for saving a link.
--
--   invoice_line_items.square_catalog_variation_id
--     Written from the Square order payload by the invoice sync, not from the
--     mirror. Its sibling column pos_line_items.square_variation_id has the
--     same provenance and carries 4 orphans out of 5,361 today — direct proof
--     that Square line items do reference variations the mirror has not caught
--     up with. This column reads clean by luck of which orders were invoices.
--
--   tap_assignments.restock_variation_id
--     Set from the taproom picker, which reads /api/production/square-catalog —
--     fetchCatalogItems(), i.e. LIVE Square, not the mirror. An operator can
--     pick a variation created minutes ago and the mirror will not have it
--     until the nightly sync.
--
-- ON DELETE RESTRICT, chosen deliberately rather than defaulted. The catalog
-- sync never hard-deletes: syncSquareCatalog upserts, and rows Square stops
-- returning are flagged is_deleted instead of removed, so the mapping pointing
-- at them stays inspectable (20260925100000_catalog_deletion_tracking.sql).
-- Production currently holds 53 flagged variations and 16 flagged items, all
-- still present and still referenced with zero orphans — the soft-delete design
-- working as intended. So RESTRICT will not fire during normal operation; what
-- it does is enforce that invariant in the database, which is the point. The
-- alternative, SET NULL, is wrong here on its own terms: this table is an
-- append-only reconciliation record, and blanking which variation a historical
-- count was taken against destroys the audit trail rather than protecting it.

alter table public.square_inventory_reconciliations
  add constraint square_inventory_reconciliations_base_variation_fkey
  foreign key (base_square_variation_id)
  references public.square_catalog_variations (square_variation_id)
  on delete restrict;

comment on constraint square_inventory_reconciliations_base_variation_fkey
  on public.square_inventory_reconciliations is
  'The base variation is read from the catalog mirror when the plan is built, so the mirror row always exists first. RESTRICT enforces the mirror''s soft-delete invariant: a variation that a reconciliation was recorded against is flagged is_deleted, never removed.';

-- The FK's own enforcement scan, and the drift views that group history by
-- variation, both read this column.
create index if not exists square_inventory_reconciliations_base_variation_idx
  on public.square_inventory_reconciliations (base_square_variation_id);
