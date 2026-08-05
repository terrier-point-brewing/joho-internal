-- Repair batch ingredient commitments that drifted from their recipe.
--
-- upsertCommitments() only ever wrote the CURRENT recipe's lines; it never
-- released rows for ingredients the batch had dropped. Swapping a batch onto a
-- new recipe therefore left the old recipe's ingredients committed, and the
-- shortfall dialog — which reads commitments, not the recipe — reported the
-- union of both. B-056 showed Epic Hazy IPA's twelve ingredients while linked
-- to Pace Yourself Pilsner.
--
-- Separately, editing a recipe rewrites recipe_ingredients without touching any
-- batch already committed against it, so quantities froze at whatever was in
-- force when the batch was scheduled (B-056 held 900 lb of Pilsner Malt against
-- a recipe that had since moved to 660).
--
-- The application fix lands alongside this in lib/production/commitments.ts.
-- This migration repairs the rows already on disk. It is set-based rather than
-- pinned to B-056 so any batch in the same state is corrected, and it is safe to
-- re-run: both statements are no-ops once the data agrees with the recipe.
--
-- Scope: only PRE-BREW batches (planning, backlog). Batches past that point have
-- already had their ingredients physically deducted from stock_quantity, so
-- rewriting their commitments would double-charge the stock they consumed.

-- 1. Release commitments for ingredients that are not in the batch's recipe.
update batch_ingredient_commitments c
   set released_at = now()
  from brew_batches b
 where b.id = c.batch_id
   and c.released_at is null
   and b.status in ('planning', 'backlog')
   and not exists (
         select 1
           from recipe_ingredients ri
          where ri.recipe_id     = b.recipe_id
            and ri.ingredient_id = c.ingredient_id
       );

-- 2. Restate surviving commitments at the recipe's current rate × batch volume.
update batch_ingredient_commitments c
   set committed_qty = ri.quantity_per_bbl * b.volume_bbl
  from brew_batches b
  join recipe_ingredients ri on ri.recipe_id = b.recipe_id
 where b.id = c.batch_id
   and ri.ingredient_id = c.ingredient_id
   and c.released_at is null
   and b.status in ('planning', 'backlog')
   and b.volume_bbl is not null
   and abs(c.committed_qty - ri.quantity_per_bbl * b.volume_bbl) > 0.001;
