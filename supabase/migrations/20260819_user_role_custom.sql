-- Adds the 'custom' value to user_role. ALTER TYPE ... ADD VALUE cannot be
-- used in the same transaction that adds it (Supabase runs each migration
-- file in one transaction), so this is a standalone file; the table that
-- consumes 'custom' follows in the next migration.
alter type user_role add value 'custom';
