-- Draft restock line item → tap mapping.
--
-- A bartender rings a $0 "Draft Restock" Square item with one variation per tap
-- when they swap a keg on that tap. `restock_variation_id` is the Square catalog
-- variation id for this tap's line, so the taproom-consumption sync can resolve
-- an order line item back to a tap → recipe → cold-storage keg (the shipment it
-- drains) and to the draft SKU it recounts back to full.
alter table tap_assignments
  add column if not exists restock_variation_id text;

comment on column tap_assignments.restock_variation_id is
  'Square catalog variation id of the $0 Draft Restock line for this tap. When a completed order carries this variation, the taproom-consumption sync records a draft keg-swap shipment and recounts the mapped draft SKU to its full-keg volume.';
