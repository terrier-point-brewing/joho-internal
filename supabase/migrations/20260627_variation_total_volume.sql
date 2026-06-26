-- supabase/migrations/20260627_variation_total_volume.sql

alter table public.packaging_variations
  add column if not exists total_volume_fl_oz numeric;

update public.packaging_variations v
set total_volume_fl_oz = c.volume_fl_oz * coalesce(
  case
    when v.format = 'case' then t.can_count
    when v.format in ('4-pack', '6-pack') then p.can_count
    else 1
  end, 1)
from public.packaging_items c
left join public.packaging_items t on t.id = v.tray_id
left join public.packaging_items p on p.id = v.paktech_id
where c.id = v.container_id;

alter table public.packaging_variations
  alter column total_volume_fl_oz set not null;

create or replace function public.recompute_variation_total_volume() returns trigger as $$
begin
  update public.packaging_variations v
  set total_volume_fl_oz = c.volume_fl_oz * coalesce(
    case
      when v.format = 'case' then t.can_count
      when v.format in ('4-pack', '6-pack') then p.can_count
      else 1
    end, 1)
  from public.packaging_items c
  left join public.packaging_items t on t.id = v.tray_id
  left join public.packaging_items p on p.id = v.paktech_id
  where c.id = v.container_id
    and (v.container_id = new.id or v.tray_id = new.id or v.paktech_id = new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_recompute_variation_total_volume on public.packaging_items;
create trigger trg_recompute_variation_total_volume
  after update of volume_fl_oz, can_count on public.packaging_items
  for each row execute function public.recompute_variation_total_volume();
