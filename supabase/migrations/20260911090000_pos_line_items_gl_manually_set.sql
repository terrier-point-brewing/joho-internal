-- Separate "a person chose this GL account" from "a rule filled it in".
--
-- pos_line_items.chart_of_accounts_id has three writers:
--   1. the Square sync (buildPosLineItems)      — writes the catalog mapping
--   2. the auto-map pass (autoMapPosLineItems)  — writes the catalog mapping
--   3. the Orders grid PATCH                    — writes a person's choice
--
-- but lib/finance/financials/aggregateRows.ts documents the column as "manual
-- override" and classifies purely on presence:
--
--   mappingSource = chart_of_accounts_id ? "manual" : prefill ? "rule" : "unmapped"
--
-- So every rule-derived mapping reports as "manual" — 4,939 of 4,983 live rows
-- (99%). The `rule` bucket is nearly empty when it should hold almost all of
-- them, and the Orders grid's "override" badge fires on every line, making it
-- useless for spotting the handful a human actually changed.
--
-- The tempting fix — stop writing the catalog mapping into the column and let
-- readers prefill it — is NOT safe. balances/providers/transactionPostings.ts
-- (sumPos) filters `.eq("chart_of_accounts_id", coaId)` with no prefill
-- fallback, so emptying the column would zero out every POS figure on the
-- balance sheet. The column stays exactly as it is; provenance moves to its own
-- flag beside it.

alter table public.pos_line_items
  add column if not exists gl_manually_set boolean not null default false;

comment on column public.pos_line_items.gl_manually_set is
  'True only when a person set chart_of_accounts_id by hand via the Orders grid. The Square sync and the auto-map pass both write that column from the catalog mapping and leave this false, so it — not the column''s presence — is what separates mappingSource "manual" from "rule".';

-- No backfill: every existing row is rule-derived. Verified before writing this
-- migration — 0 of 4,983 rows carry a chart_of_accounts_id that differs from
-- what coalesce(chart_of_accounts_id_pos, chart_of_accounts_id) on their
-- square_catalog_variations row would produce, i.e. nothing has been hand-set
-- to date. `default false` is therefore already the correct value everywhere,
-- and the query below should return zero rows. If it ever returns some (a hand
-- mapping made between this being written and being applied), those rows want
-- gl_manually_set = true:
--
--   select li.id
--   from pos_line_items li
--   left join square_catalog_variations v
--     on v.square_variation_id = li.square_variation_id
--   where li.chart_of_accounts_id is distinct from
--         coalesce(v.chart_of_accounts_id_pos, v.chart_of_accounts_id);

-- Partial index: the flag is read to classify provenance and, in the Orders
-- grid, to find the few genuinely hand-mapped lines. `true` is the rare value,
-- so index only that side.
create index if not exists pos_line_items_gl_manually_set_idx
  on public.pos_line_items (gl_manually_set)
  where gl_manually_set;
