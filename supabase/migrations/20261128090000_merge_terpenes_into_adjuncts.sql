-- Fold the "Terpenes" ingredient category into "Adjuncts". Each terpene's
-- name gains a "Terpenes" suffix (e.g. "Citra" -> "Citra Terpenes") so it
-- stays distinguishable from hops/fruit adjuncts once the category is gone.
update public.ingredients
set name = case when name ilike '%terpene%' then name else name || ' Terpenes' end,
    category = 'Adjuncts'
where category = 'Terpenes';
