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
