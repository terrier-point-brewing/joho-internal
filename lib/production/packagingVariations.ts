import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackagingVariationFormat, PackagingVariation } from "@/app/production/types";
import type { ControlsConfig } from "@/lib/table/types";

export const PACKAGING_VARIATION_SELECT = `
  *,
  container:packaging_items!packaging_variations_container_id_fkey(id, name, type, volume_fl_oz),
  lid:packaging_items!packaging_variations_lid_id_fkey(id, name),
  paktech:packaging_items!packaging_variations_paktech_id_fkey(id, name),
  tray:packaging_items!packaging_variations_tray_id_fkey(id, name),
  label:packaging_items!packaging_variations_label_id_fkey(id, name),
  contract_brewing_partners(company_name)
`;

// The generic house kegs (1/2, 1/4, 1/6 Keg) — keg containers with no contract
// partner. Every recipe can be drained from these, so they're linked to each
// recipe by default (backfill migration + recipe-creation route) and surface in
// the draft swap-keg dropdown as ordinary recipe_packaging_variations.
export async function getGenericKegVariationIds(supabase: SupabaseClient): Promise<string[]> {
  const { data } = await supabase
    .from("packaging_variations")
    .select("id, container:packaging_items!packaging_variations_container_id_fkey(type)")
    .is("partner_id", null)
    .eq("is_active", true);
  return (data ?? [])
    .filter((v) => (v.container as unknown as { type?: string } | null)?.type === "keg")
    .map((v) => v.id as string);
}

export function validateFormat(format: string, paktech_id: string | null, tray_id: string | null): string | null {
  if (format === "4-pack" || format === "6-pack") {
    if (!paktech_id) return `format "${format}" requires paktech_id`;
    if (tray_id) return `format "${format}" must not have tray_id`;
  }
  if (format === "case") {
    if (!tray_id) return `format "case" requires tray_id`;
    if (!paktech_id) return `format "case" requires paktech_id`;
  }
  if (format === "loose" && (paktech_id || tray_id)) {
    return `format "loose" must not have paktech_id or tray_id`;
  }
  return null;
}

// Which sibling packaging_variation a "case" cracks into (4-pack or 6-pack) is
// ambiguous from format/volume alone whenever a recipe sells both pack sizes
// of the same can -- so it's an explicit link (breaks_into_variation_id),
// validated here against the candidate row the caller already fetched.
export function validateBreaksInto(
  format: string,
  breaksIntoVariationId: string | null,
  target: { format: string; container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null } | null,
  self: { container_id: string; lid_id: string | null; label_id: string | null; partner_id: string | null }
): string | null {
  if (format !== "case") {
    return breaksIntoVariationId ? `only format "case" may set breaks_into_variation_id` : null;
  }
  if (!breaksIntoVariationId) return `format "case" requires breaks_into_variation_id`;
  if (!target) return `breaks_into_variation_id does not reference an existing variation`;
  if (target.format !== "4-pack" && target.format !== "6-pack") {
    return `breaks_into_variation_id must reference a 4-pack or 6-pack variation`;
  }
  if (
    target.container_id !== self.container_id ||
    (target.lid_id ?? null) !== (self.lid_id ?? null) ||
    (target.label_id ?? null) !== (self.label_id ?? null) ||
    (target.partner_id ?? null) !== (self.partner_id ?? null)
  ) {
    return `breaks_into_variation_id must reference a variation in the same can-identity family (container/lid/label/partner)`;
  }
  return null;
}

// Paktech units consumed per package unit: 1 for a 4-pack/6-pack (the whole
// package IS one paktech'd bundle), or cansPerCase / cansPerPaktech for a
// case (built from several paktech'd bundles boxed into one tray).
export async function getPaktechUnitsPerPackage(
  supabase: SupabaseClient,
  { format, tray_id, paktech_id }: { format: string; tray_id: string | null; paktech_id: string | null }
): Promise<number> {
  if (!paktech_id) return 0;
  if (format === "4-pack" || format === "6-pack") return 1;
  if (format === "case" && tray_id) {
    const [{ data: tray }, { data: paktech }] = await Promise.all([
      supabase.from("packaging_items").select("can_count").eq("id", tray_id).single(),
      supabase.from("packaging_items").select("can_count").eq("id", paktech_id).single(),
    ]);
    const paktechCount = paktech?.can_count ?? 0;
    if (!paktechCount) return 0;
    return (tray?.can_count ?? 0) / paktechCount;
  }
  return 0;
}

export async function getUnitsPerPackage(
  supabase: SupabaseClient,
  { format, tray_id, paktech_id }: { format: string; tray_id: string | null; paktech_id: string | null }
): Promise<number> {
  if (format === "case" && tray_id) {
    const { data: tray } = await supabase.from("packaging_items").select("can_count").eq("id", tray_id).single();
    return tray?.can_count ?? 1;
  }
  if ((format === "4-pack" || format === "6-pack") && paktech_id) {
    const { data: paktech } = await supabase.from("packaging_items").select("can_count").eq("id", paktech_id).single();
    return paktech?.can_count ?? 1;
  }
  return 1;
}

export async function computeTotalVolumeFlOz(
  supabase: SupabaseClient,
  { container_id, format, tray_id, paktech_id }: { container_id: string; format: string; tray_id: string | null; paktech_id: string | null }
): Promise<number> {
  const { data: container } = await supabase.from("packaging_items").select("volume_fl_oz").eq("id", container_id).single();
  const containerVolume = container?.volume_fl_oz ?? 0;
  const unitsPerPackage = await getUnitsPerPackage(supabase, { format, tray_id, paktech_id });
  return containerVolume * unitsPerPackage;
}

export const FORMATS: { value: PackagingVariationFormat; label: string }[] = [
  { value: "loose",   label: "Loose" },
  { value: "4-pack",  label: "4-Pack" },
  { value: "6-pack",  label: "6-Pack" },
  { value: "case",    label: "Case" },
];

export const FORMAT_ORDER: PackagingVariationFormat[] = ["loose", "4-pack", "6-pack", "case"];

// ─── Shared search/filter config ─────────────────────────────────────────────
// Consumed by both PackagingVariationsPanel (URL-synced via useTableControls)
// and the recipe-linking picker (local state via applyControls). Keeping the
// accessors/matchers here is the single source of truth for how the catalog is
// searched and filtered — kegs collapse to the "loose" format bucket; the
// "generic" partner token means partner_id === null.
export const PACKAGING_VARIATION_CONTROLS: ControlsConfig<PackagingVariation> = {
  search: [{ param: "q", accessor: (v) => v.name }],
  filters: [
    { param: "type", accessor: (v) => v.container?.type ?? "" },
    { param: "format", matches: (v, sel) => sel.includes(v.container?.type === "keg" ? "loose" : v.format) },
    { param: "partner", matches: (v, sel) => sel.some((s) => (s === "generic" ? v.partner_id === null : v.partner_id === s)) },
  ],
};

export const PKGVAR_TYPE_OPTIONS = [
  { value: "keg", label: "Keg" },
  { value: "can", label: "Can" },
];
export const PKGVAR_FORMAT_OPTIONS = FORMATS.map((f) => ({ value: f.value, label: f.label }));

/** Partner filter chip options, derived from the loaded variations so partners
 *  with no records never appear. Always leads with the "generic" bucket. */
export function buildVariationPartnerOptions(
  variations: PackagingVariation[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const v of variations) {
    if (v.partner_id && v.contract_brewing_partners?.company_name) {
      seen.set(v.partner_id, v.contract_brewing_partners.company_name);
    }
  }
  return [
    { value: "generic", label: "Generic" },
    ...Array.from(seen.entries()).map(([id, name]) => ({ value: id, label: name })),
  ];
}

/** Catalog display order: kegs first, then by format order, then by name.
 *  Shared so the Panel table and the picker checklist order identically. */
export function sortVariationsForDisplay(rows: PackagingVariation[]): PackagingVariation[] {
  return [...rows].sort((a, b) => {
    const ta = a.container?.type === "keg" ? 0 : 1;
    const tb = b.container?.type === "keg" ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const fa = FORMAT_ORDER.indexOf(a.container?.type === "keg" ? "loose" : a.format);
    const fb = FORMAT_ORDER.indexOf(b.container?.type === "keg" ? "loose" : b.format);
    if (fa !== fb) return fa - fb;
    return a.name.localeCompare(b.name);
  });
}

export function needsPaktech(format: PackagingVariationFormat)   { return format === "4-pack" || format === "6-pack" || format === "case"; }
export function needsTray(format: PackagingVariationFormat)       { return format === "case"; }
export function needsBreaksInto(format: PackagingVariationFormat) { return format === "case"; }

export interface VariationCombo {
  container_id: string;
  format: string;
  lid_id: string | null;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
}

export function isDuplicateCombo(candidate: VariationCombo, existing: VariationCombo[]): boolean {
  return existing.some((e) =>
    e.container_id === candidate.container_id &&
    e.format === candidate.format &&
    e.lid_id === candidate.lid_id &&
    e.paktech_id === candidate.paktech_id &&
    e.tray_id === candidate.tray_id &&
    e.label_id === candidate.label_id &&
    e.partner_id === candidate.partner_id
  );
}
