-- square_invoice_id was added to track the Square invoice created at batch planning time.
-- No-op on a fresh DB (column already exists in baseline's brew_batches CREATE TABLE IF NOT EXISTS),
-- but required as a historical record for existing DBs created before the column was added.
alter table brew_batches add column if not exists square_invoice_id text;
