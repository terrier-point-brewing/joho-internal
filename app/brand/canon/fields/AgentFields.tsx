"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

/** A single-line editable entry in one of the agent lists. */
interface Line {
  id: string;
  text: string;
}

const toLines = (items: string[] | undefined): Line[] =>
  (items ?? []).map((text, i) => ({ id: `line:${i}`, text }));

const toStrings = (lines: Line[]): string[] => lines.map((l) => l.text);

function StringListField({
  label,
  description,
  items,
  onChange,
  addLabel,
  placeholder,
}: {
  label: string;
  description: string;
  items: string[] | undefined;
  onChange: (next: string[]) => void;
  addLabel: string;
  placeholder: string;
}) {
  return (
    <ListField<Line>
      label={label}
      description={description}
      addLabel={addLabel}
      items={toLines(items)}
      onChange={(lines) => onChange(toStrings(lines))}
      // Index-derived ids: these lists are plain strings with no identity of
      // their own, and they are stored as strings. The id exists only to key
      // the rows while editing.
      blank={() => ({ id: `line:${(items ?? []).length}`, text: "" })}
      renderItem={(line, update) => (
        <input
          className="inp-sm w-full"
          value={line.text}
          onChange={(e) => update({ text: e.target.value })}
          placeholder={placeholder}
          aria-label={label}
        />
      )}
    />
  );
}

/**
 * Typed editor for the Agent Rules subtab — the last one still on raw JSON.
 *
 * Only `agentTechnical` is unique to this tab; everything else in the compiled
 * markdown comes from the other subtabs. The Never List, precedence and hard
 * rules live here because they are machine-facing and have no other home.
 */
export default function AgentFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <StringListField
        label="The Never List"
        description="Absolutes. One of these in a piece of work fails it outright."
        addLabel="Add"
        placeholder="Never …"
        items={draft.neverList}
        onChange={(neverList) => onChange({ ...draft, neverList })}
      />

      <StringListField
        label="Precedence"
        description="When two directives conflict, the earlier one wins. Order is the meaning here."
        addLabel="Add step"
        placeholder="Safety before brand"
        items={draft.precedence}
        onChange={(precedence) => onChange({ ...draft, precedence })}
      />

      <StringListField
        label="Hard rules"
        description="Non-negotiables — each one is a fail-the-review line."
        addLabel="Add rule"
        placeholder="A hard rule"
        items={draft.hardRules}
        onChange={(hardRules) => onChange({ ...draft, hardRules })}
      />

      <StringListField
        label="Technical rules for agents"
        description="Direction that applies only to agents and to nothing a human reads elsewhere — token binding, asset handling, what to do when the canon is ambiguous. The one section of the compiled markdown not derived from another subtab."
        addLabel="Add rule"
        placeholder="Bind to role tokens, never to colour names"
        items={draft.agentTechnical}
        onChange={(agentTechnical) => onChange({ ...draft, agentTechnical })}
      />
    </div>
  );
}
