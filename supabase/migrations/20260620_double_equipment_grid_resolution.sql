-- Double equipment grid coordinates/sizes to support quarter-cell placement
-- resolution. GRID_CELL_PX is halved client-side (48px -> 24px) and
-- GRID_COLS/GRID_ROWS are doubled (24x16 -> 48x32) in the same change, so
-- multiplying existing rows by 2 preserves every tank's current visual
-- position and size exactly.
--
-- WHERE clause guards against double-application (e.g. accidental manual
-- re-run outside the normal Supabase migration tracking): old-resolution
-- grid_col/grid_row never reached 24/16 (the old GRID_COLS/GRID_ROWS), and
-- grid_width/grid_height never exceeded 10 (the equipment form's max). Once
-- a row has been doubled, its values fall outside these bounds, so a second
-- run of this UPDATE becomes a no-op for that row instead of quadrupling it.
update public.equipment
set
  grid_row    = grid_row * 2,
  grid_col    = grid_col * 2,
  grid_width  = grid_width * 2,
  grid_height = grid_height * 2
where
  (grid_col is null or grid_col < 24)
  and (grid_row is null or grid_row < 16)
  and grid_width  <= 10
  and grid_height <= 10;
