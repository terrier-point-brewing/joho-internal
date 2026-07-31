"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Element = BrandCanon["labelChassis"]["elements"][number];

/**
 * Editor for the label chassis — the fixed frame every release is poured into.
 *
 * This is the beer-label template's own specification, and until Phase A it was
 * stored in the canon, editable nowhere, and rendered nowhere: not in the guide
 * and not in the Agent Rules brief. An agent asked to lay out a label was given
 * nothing about the chassis it had to respect.
 *
 * Elements are ordered and numbered because the numbering is the diagram — "1
 * Wordmark, 2 Bordered art window, 3 Title slot, 4 The chop" reads top-down the
 * way the panel does.
 */
export default function ChassisFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const chassis = draft.labelChassis ?? { narrative: "", elements: [] };

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">Label chassis — narrative</span>
        <textarea
          className="inp min-h-24 text-sm"
          value={chassis.narrative ?? ""}
          onChange={(e) =>
            onChange({ ...draft, labelChassis: { ...chassis, narrative: e.target.value } })
          }
          placeholder="Why the chassis is fixed and what it is protecting."
        />
      </label>

      <ListField<Element>
        label="Chassis elements"
        description="Each fixed element of the panel, in the order it reads. These become the template's slots."
        addLabel="Add element"
        items={chassis.elements ?? []}
        onChange={(elements) => onChange({ ...draft, labelChassis: { ...chassis, elements } })}
        blank={() => ({ n: String((chassis.elements?.length ?? 0) + 1), title: "", desc: "" })}
        renderItem={(element, update) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                className="inp-sm w-12 shrink-0"
                value={element.n}
                onChange={(e) => update({ n: e.target.value })}
                aria-label="Number"
                placeholder="#"
              />
              <input
                className="inp-sm flex-1"
                value={element.title}
                onChange={(e) => update({ title: e.target.value })}
                aria-label="Element"
                placeholder="Bordered art window"
              />
            </div>
            <textarea
              className="inp min-h-16 text-sm"
              value={element.desc}
              onChange={(e) => update({ desc: e.target.value })}
              aria-label="Description"
              placeholder="Position, size, and what may never change about it."
            />
          </div>
        )}
      />
    </div>
  );
}
