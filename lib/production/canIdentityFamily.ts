// lib/production/canIdentityFamily.ts
//
// Shared primitives for grouping packaging_variations into "can-identity families".
// A family = variations that share (container_id, lid_id, label_id, partner_id)
// (null-safe) and differ only by tier/format (loose < 4-pack < 6-pack < case).
// label_id is what separates Regular (printed, NULL) from a labeled variant like
// "Be Like Mike". NOTE: the 4-tuple is only unique WITHIN a recipe — callers must
// pre-filter rows to a single recipe before grouping.

export const CAN_FORMATS = new Set(["loose", "4-pack", "6-pack", "case"]);

export const nullSafeEq = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

export interface FamilyPackagingRow {
  id: string;
  format: string;
  container_id: string;
  lid_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  total_volume_fl_oz: number;
}

export function familyKey(
  v: Pick<FamilyPackagingRow, "container_id" | "lid_id" | "label_id" | "partner_id">,
): string {
  return [v.container_id, v.lid_id ?? "∅", v.label_id ?? "∅", v.partner_id ?? "∅"].join("|");
}

export function groupCanFamilies(rows: FamilyPackagingRow[]): FamilyPackagingRow[][] {
  const byKey = new Map<string, FamilyPackagingRow[]>();
  for (const v of rows) {
    if (!CAN_FORMATS.has(v.format)) continue;
    const key = familyKey(v);
    const list = byKey.get(key);
    if (list) list.push(v);
    else byKey.set(key, [v]);
  }
  return [...byKey.values()];
}
