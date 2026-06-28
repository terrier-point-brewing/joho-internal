-- Inventory-unit semantics on the catalog mirror. Centralizes "how is this
-- variation counted (fl oz vs each)" and "how much volume does one sold unit
-- represent" so consumers (sell-through, taproom inventory) stop re-parsing
-- variation names independently. Populated by the catalog sync route via
-- lib/square/catalogUnits.ts. Nullable: a value is only known for beer SKUs
-- whose names carry size/pack/keg tokens.

alter table public.square_catalog_variations
  add column if not exists inventory_unit text
    check (inventory_unit in ('fl_oz', 'each')),
  add column if not exists volume_fl_oz_per_unit numeric;
