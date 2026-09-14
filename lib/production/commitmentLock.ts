/**
 * A commitment locks the moment its deposit is paid (`locked_on`): the
 * partner has put money down on THIS recipe, THIS volume, THIS channel. The
 * column was stamped by every payment path and read by nothing — a locked
 * deal could be re-pointed at another beer with no trace beyond the audit
 * log. Changing one of these fields after lock now needs a reason, which is
 * kept on the commitment's notes.
 */

export const LOCKED_FIELDS = ["recipe_id", "partner_id", "channel", "volume_bbl"] as const;
export type LockedField = (typeof LOCKED_FIELDS)[number];

type Row = Partial<Record<LockedField, unknown>>;

/** Which locked fields a patch actually changes (same value → not a change). */
export function lockedFieldsChanged(current: Row, patch: Row): LockedField[] {
  const changed: LockedField[] = [];
  for (const f of LOCKED_FIELDS) {
    if (!(f in patch)) continue;
    const before = normalize(current[f]);
    const after = normalize(patch[f]);
    if (before !== after) changed.push(f);
  }
  return changed;
}

function normalize(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) {
    return String(Math.round(Number(v) * 100) / 100);
  }
  return String(v);
}

/** The note line prepended to the commitment when a locked field changes. */
export function unlockNote(today: string, fields: LockedField[], reason: string): string {
  const labels: Record<LockedField, string> = {
    recipe_id: "recipe", partner_id: "partner", channel: "channel", volume_bbl: "volume",
  };
  return `[${today} changed ${fields.map((f) => labels[f]).join(", ")} after lock: ${reason.trim()}]`;
}
