"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Value = BrandCanon["values"][number];

/** Typed editor for the Ethos values — replaces the raw-JSON slice editor. */
export default function EthosFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  return (
    <ListField<Value>
      label="Values"
      description="Each value, what it means in practice, and what holding to it costs."
      addLabel="Add value"
      items={draft.values}
      onChange={(values) => onChange({ ...draft, values })}
      // A fresh id is required: diffCanon matches by it, and an item without
      // one is reported as a delete plus an add on the next publish.
      blank={() => ({
        id: crypto.randomUUID(),
        n: String(draft.values.length + 1),
        title: "",
        means: "",
        cost: "",
      })}
      renderItem={(value, update) => (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              className="inp-sm w-12 shrink-0"
              value={value.n}
              onChange={(e) => update({ n: e.target.value })}
              aria-label="Number"
              placeholder="#"
            />
            <input
              className="inp-sm flex-1"
              value={value.title}
              onChange={(e) => update({ title: e.target.value })}
              aria-label="Title"
              placeholder="Title"
            />
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">What it means</span>
            <textarea
              className="inp min-h-16 text-sm"
              value={value.means}
              onChange={(e) => update({ means: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">The cost</span>
            <textarea
              className="inp min-h-16 text-sm"
              value={value.cost}
              onChange={(e) => update({ cost: e.target.value })}
            />
          </label>
        </div>
      )}
    />
  );
}
