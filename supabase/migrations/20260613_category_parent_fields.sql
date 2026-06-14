alter table public.square_catalog_items
  add column if not exists parent_category_id   text,
  add column if not exists is_top_level_category boolean,
  add column if not exists parent_category_name  text;
