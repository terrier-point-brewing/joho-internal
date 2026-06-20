-- Double equipment grid coordinates/sizes to support quarter-cell placement
-- resolution. GRID_CELL_PX is halved client-side (48px -> 24px) and
-- GRID_COLS/GRID_ROWS are doubled (24x16 -> 48x32) in the same change, so
-- multiplying existing rows by 2 preserves every tank's current visual
-- position and size exactly.
update public.equipment
set
  grid_row    = grid_row * 2,
  grid_col    = grid_col * 2,
  grid_width  = grid_width * 2,
  grid_height = grid_height * 2;
