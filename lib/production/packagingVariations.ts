import type { SupabaseClient } from "@supabase/supabase-js";

export const PACKAGING_VARIATION_SELECT = `
  *,
  container:packaging_items!packaging_variations_container_id_fkey(id, name, type, volume_fl_oz),
  lid:packaging_items!packaging_variations_lid_id_fkey(id, name),
  paktech:packaging_items!packaging_variations_paktech_id_fkey(id, name),
  tray:packaging_items!packaging_variations_tray_id_fkey(id, name),
  label:packaging_items!packaging_variations_label_id_fkey(id, name),
  contract_brewing_partners(company_name)
`;

export function validateFormat(format: string, paktech_id: string | null, tray_id: string | null): string | null {
  if (format === "4-pack" || format === "6-pack") {
    if (!paktech_id) return `format "${format}" requires paktech_id`;
    if (tray_id) return `format "${format}" must not have tray_id`;
  }
  if (format === "case") {
    if (!tray_id) return `format "case" requires tray_id`;
    if (paktech_id) return `format "case" must not have paktech_id`;
  }
  if (format === "loose" && (paktech_id || tray_id)) {
    return `format "loose" must not have paktech_id or tray_id`;
  }
  return null;
}

export async function computeTotalVolumeFlOz(
  supabase: SupabaseClient,
  { container_id, format, tray_id, paktech_id }: { container_id: string; format: string; tray_id: string | null; paktech_id: string | null }
): Promise<number> {
  const { data: container } = await supabase.from("packaging_items").select("volume_fl_oz").eq("id", container_id).single();
  const containerVolume = container?.volume_fl_oz ?? 0;
  let unitsPerPackage = 1;
  if (format === "case" && tray_id) {
    const { data: tray } = await supabase.from("packaging_items").select("can_count").eq("id", tray_id).single();
    unitsPerPackage = tray?.can_count ?? 1;
  } else if ((format === "4-pack" || format === "6-pack") && paktech_id) {
    const { data: paktech } = await supabase.from("packaging_items").select("can_count").eq("id", paktech_id).single();
    unitsPerPackage = paktech?.can_count ?? 1;
  }
  return containerVolume * unitsPerPackage;
}
