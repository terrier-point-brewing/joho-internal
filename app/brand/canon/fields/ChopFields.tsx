"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Spec = BrandCanon["chop"]["specs"][number];

/**
 * Editor for the chop — its narrative and its spec sheet.
 *
 * Lives on the Marks tab because the chop IS a mark; it simply was not owned by
 * any subtab before Phase A, so its placement, footprint and color rules were
 * stored and editable nowhere. Those rules are what a label template's chop slot
 * resolves against, so they have to be data an admin can correct.
 *
 * Specs are free-form key/value rather than a fixed set of fields: the sheet
 * currently carries Color / Position / Footprint / Rendering / Content, and
 * pinning those as columns would make adding a sixth a code change.
 */
export default function ChopFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const chop = draft.chop ?? { narrative: "", specs: [] };

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">The chop — narrative</span>
        <textarea
          className="inp min-h-24 text-sm"
          value={chop.narrative ?? ""}
          onChange={(e) => onChange({ ...draft, chop: { ...chop, narrative: e.target.value } })}
          placeholder="What the chop is and what it is for."
        />
      </label>

      <ListField<Spec>
        label="Chop specification"
        description="The rules a renderer places the chop by — color, position, footprint, rendering, content."
        addLabel="Add spec row"
        items={chop.specs ?? []}
        onChange={(specs) => onChange({ ...draft, chop: { ...chop, specs } })}
        blank={() => ({ key: "", value: "" })}
        renderItem={(spec, update) => (
          <div className="flex items-start gap-2">
            <input
              className="inp-sm w-44 shrink-0"
              value={spec.key}
              onChange={(e) => update({ key: e.target.value })}
              aria-label="Spec name"
              placeholder="Footprint"
            />
            <input
              className="inp-sm flex-1"
              value={spec.value}
              onChange={(e) => update({ value: e.target.value })}
              aria-label="Spec value"
              placeholder="Square, ratio 1:1 to 1:1.15; height 8–10% of art-window height"
            />
          </div>
        )}
      />
    </div>
  );
}
