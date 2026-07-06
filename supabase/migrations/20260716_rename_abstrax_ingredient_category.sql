-- Rename the "Abstrax" ingredient category to "Terpenes". The ingredients
-- category column is free-text (no check constraint), so this is a pure data
-- backfill for existing rows — the application now writes "Terpenes" going
-- forward (see app/production/types.ts). Idempotent: a no-op once applied.

update public.ingredients
set category = 'Terpenes'
where category = 'Abstrax';
