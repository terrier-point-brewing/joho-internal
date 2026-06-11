-- Enables upsert-based sync in sync-square route, eliminating the delete+insert window.
-- DROP + ADD pattern is used because the constraint was already added to the live DB via MCP.
alter table invoice_line_items
  drop constraint if exists invoice_line_items_invoice_sort_key;
alter table invoice_line_items
  add constraint invoice_line_items_invoice_sort_key unique (invoice_id, sort_order);
