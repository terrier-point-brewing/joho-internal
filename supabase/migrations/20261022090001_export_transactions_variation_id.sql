-- ─── export_transactions.variation_id: a shipment points at a variation, not a name ──
--
-- Every reader that needs to know WHICH packaging variation a shipment used
-- resolves it by matching `variant_label` — a string snapshotted at ship time —
-- against `packaging_variations.name`. That makes the variation's display name a
-- load-bearing foreign key, so renaming a variation silently orphans every row
-- already shipped under the old spelling.
--
-- It happened: "Fortnight Octoberfest - 16 oz Labeled can - 16oz Labeled Can
-- Case" was renamed to "Fortnight Oktoberfest - 16oz Labeled Can Case", and the
-- Aug 21 2026 shipment behind it could no longer be invoiced at all — the
-- distribution path threw "0 candidates", and billing it as contract brewing
-- quietly dropped the packaging-materials line because the same lookup failed
-- there too.
--
-- variation_id is now the identity. `variant_label` stays, demoted to what it
-- always should have been: a snapshot of what the label read on the day, useful
-- for history and never for lookup. Readers fall back to the name match when
-- variation_id is null, so pre-existing rows keep working exactly as before.

alter table public.export_transactions
  add column if not exists variation_id uuid references public.packaging_variations(id);

comment on column public.export_transactions.variation_id is
  'The packaging variation shipped. Authoritative — resolve by this, never by variant_label, which is a display snapshot that goes stale on rename.';

create index if not exists export_transactions_variation_id_idx
  on public.export_transactions (variation_id);

-- ── Backfill: the unambiguous name matches ────────────────────────────────────
-- Exactly one candidate under the row's recipe, same rule every reader applies
-- today, so this changes no result — it only pins it against future renames.
update public.export_transactions et
set variation_id = m.variation_id
from (
  select rpv.recipe_id, pv.name, min(rpv.variation_id::text)::uuid as variation_id
  from public.recipe_packaging_variations rpv
  join public.packaging_variations pv on pv.id = rpv.variation_id
  group by rpv.recipe_id, pv.name
  having count(*) = 1
) m
where et.variation_id is null
  and et.recipe_id = m.recipe_id
  and et.variant_label = m.name;

-- ── Repair: the two rows the rename already orphaned ─────────────────────────
-- Both are unambiguous by container + format under their recipe; named
-- explicitly rather than matched by a fuzzy rule, because a wrong guess here
-- bills a partner for the wrong beer.

-- Aug 21 2026, Fortnight Brewing, 30 cases — the shipment that could not invoice.
update public.export_transactions
set variation_id = '0d3e926a-5370-4acd-926e-99e664ff0a1b',  -- Fortnight Oktoberfest - 16oz Labeled Can Case
    variant_label = 'Fortnight Oktoberfest - 16oz Labeled Can Case'
where id = '0381df1f-b444-4129-8870-f4c538529840'
  and variation_id is null;

-- May 8 2026, taproom, 1 unit — label carried a stray "(loose)" suffix.
update public.export_transactions et
set variation_id = pv.id,
    variant_label = pv.name
from public.packaging_variations pv
where et.variant_label = 'CBC Epic Hazy IPA - 16oz Printed Can (loose)'
  and et.variation_id is null
  and pv.name = 'CBC Epic Hazy IPA - 16oz Printed Can'
  and exists (
    select 1 from public.recipe_packaging_variations rpv
    where rpv.recipe_id = et.recipe_id and rpv.variation_id = pv.id
  );
