"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";

/**
 * Editable palette swatches — the raw `key/name/hex(/cmyk/pms)` entries that
 * ThemeFacet's role→key mapping resolves against. Add/remove/edit rows here;
 * ThemeFacet is where a role gets assigned one of these keys.
 */
export default function PaletteFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  function updateColor(index: number, patch: Partial<BrandCanon["palette"][number]>) {
    const palette = draft.palette.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange({ ...draft, palette });
  }

  function addColor() {
    const palette = [
      ...draft.palette,
      { key: `color-${draft.palette.length + 1}`, name: "New color", hex: "#000000" },
    ];
    onChange({ ...draft, palette });
  }

  function removeColor(index: number) {
    onChange({ ...draft, palette: draft.palette.filter((_, i) => i !== index) });
  }

  // Which Theme roles are bound to each palette key — makes the Palette→Theme
  // linkage visible from this side (edits here ripple into those roles).
  const rolesByKey = new Map<string, string[]>();
  for (const [role, value] of Object.entries(draft.roleMap.light)) {
    if (typeof value !== "string") continue;
    rolesByKey.set(value, [...(rolesByKey.get(value) ?? []), role]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Palette</h3>
          <p className="text-xs text-muted mt-1">
            The raw ink deck. The Theme tab assigns these to UI roles — roles linked to a
            color follow edits made here.
          </p>
        </div>
        <button type="button" className="btn-secondary btn-xxs shrink-0" onClick={addColor}>
          Add color
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {draft.palette.map((color, i) => {
          const usedBy = rolesByKey.get(color.key) ?? [];
          return (
          <div key={i} className="flex flex-col gap-1 bg-surface-mid border border-line rounded-md p-2">
            <div className="flex items-center gap-2">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color.hex) ? color.hex : "#000000"}
              onChange={(e) => updateColor(i, { hex: e.target.value })}
              className="h-8 w-8 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
              aria-label={`${color.name} hex color`}
            />
            <input
              className="inp-sm w-24 shrink-0"
              value={color.key}
              onChange={(e) => updateColor(i, { key: e.target.value })}
              placeholder="key"
            />
            <input
              className="inp-sm flex-1"
              value={color.name}
              onChange={(e) => updateColor(i, { name: e.target.value })}
              placeholder="name"
            />
            <input
              className="inp-sm w-28"
              value={color.hex}
              onChange={(e) => updateColor(i, { hex: e.target.value })}
              placeholder="#rrggbb"
            />
            <input
              className="inp-sm w-24"
              value={color.cmyk ?? ""}
              onChange={(e) => updateColor(i, { cmyk: e.target.value || undefined })}
              placeholder="CMYK"
            />
            <input
              className="inp-sm w-20"
              value={color.pms ?? ""}
              onChange={(e) => updateColor(i, { pms: e.target.value || undefined })}
              placeholder="PMS"
            />
            <button type="button" className="btn-danger btn-xxs shrink-0" onClick={() => removeColor(i)}>
              Remove
            </button>
            </div>
            <p className="text-2xs text-muted pl-10">
              {usedBy.length > 0 ? (
                <>
                  <span className="text-faint">Used by roles: </span>
                  {usedBy.join(", ")}
                </>
              ) : (
                <span className="text-faint">Not assigned to any role</span>
              )}
            </p>
          </div>
          );
        })}
        {draft.palette.length === 0 && (
          <p className="text-sm text-faint">No colors yet — add one to get started.</p>
        )}
      </div>
    </div>
  );
}
