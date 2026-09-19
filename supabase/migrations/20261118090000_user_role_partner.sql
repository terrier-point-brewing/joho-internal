-- The external partner login. ALTER TYPE ... ADD VALUE cannot be used in the
-- transaction that adds it, so the value lands alone here and everything that
-- reads it lives in 20261118100000_partner_portal.sql.
alter type user_role add value if not exists 'partner';
