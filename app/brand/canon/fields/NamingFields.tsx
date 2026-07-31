"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Example = BrandCanon["naming"]["passingExamples"][number];

/**
 * Editor for the naming law — pattern, narrative, the five criteria, and the
 * examples that pass them.
 *
 * On the Voice tab because naming is language. It was unowned before Phase A,
 * which was the sharpest of the three gaps: the Releases workbench builds its
 * per-release naming check from `naming.criteria` (see app/brand/releases/page.tsx),
 * so a checklist that gates every beer name was driven by text nobody could edit.
 *
 * The criteria are FIVE fixed rows with no add or remove. The schema pins the
 * length (`criteria: z.array(z.string()).length(5)`) and `syncNamingCheck`
 * reconciles a release's saved answers against them by matching criterion text —
 * so a sixth row would fail validation on save, and rewording one deliberately
 * drops the old answer rather than silently keeping a tick against new wording.
 */
export default function NamingFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const naming = draft.naming ?? {
    pattern: "",
    narrative: "",
    criteria: ["", "", "", "", ""],
    passingExamples: [],
  };

  // Always render five, even if a stored document somehow holds fewer.
  const criteria = Array.from({ length: 5 }, (_, i) => naming.criteria?.[i] ?? "");

  function setCriterion(index: number, text: string) {
    onChange({
      ...draft,
      naming: { ...naming, criteria: criteria.map((c, i) => (i === index ? text : c)) },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">Naming pattern</span>
        <input
          className="inp-sm"
          value={naming.pattern ?? ""}
          onChange={(e) => onChange({ ...draft, naming: { ...naming, pattern: e.target.value } })}
          placeholder="Story Title — Plain Style Subtitle"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted">Naming — narrative</span>
        <textarea
          className="inp min-h-20 text-sm"
          value={naming.narrative ?? ""}
          onChange={(e) => onChange({ ...draft, naming: { ...naming, narrative: e.target.value } })}
          placeholder="How a name earns its place."
        />
      </label>

      <div className="flex flex-col gap-2">
        <div>
          <span className="text-2xs uppercase tracking-wide text-muted">The five criteria</span>
          <p className="text-2xs text-faint mt-0.5">
            Fixed at five — every release is checked against these in Releases. Rewording one
            clears the saved answer for it.
          </p>
        </div>
        {criteria.map((criterion, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="inp-sm w-8 shrink-0 grid place-items-center text-muted">{i + 1}</span>
            <input
              className="inp-sm flex-1"
              value={criterion}
              onChange={(e) => setCriterion(i, e.target.value)}
              aria-label={`Criterion ${i + 1}`}
            />
          </div>
        ))}
      </div>

      <ListField<Example>
        label="Passing examples"
        description="Illustrative names that clear all five — the story each one points to, the line it would carry on a menu, and why it passes."
        addLabel="Add example"
        items={naming.passingExamples ?? []}
        onChange={(passingExamples) => onChange({ ...draft, naming: { ...naming, passingExamples } })}
        blank={() => ({ name: "", story: "", menuDescription: "", why: "" })}
        renderItem={(example, update) => (
          <div className="flex flex-col gap-2">
            <input
              className="inp-sm"
              value={example.name}
              onChange={(e) => update({ name: e.target.value })}
              aria-label="Illustrative name — beer style"
              placeholder="Peach Blossom Spring — Jasmine Peach Lager"
            />
            <textarea
              className="inp min-h-16 text-sm"
              value={example.story ?? ""}
              onChange={(e) => update({ story: e.target.value })}
              aria-label="Story line"
              placeholder="Story line — the moment or story the name points to"
            />
            <input
              className="inp-sm"
              value={example.menuDescription ?? ""}
              onChange={(e) => update({ menuDescription: e.target.value })}
              aria-label="Menu description"
              placeholder="Menu description — how it reads on the tap list"
            />
            <input
              className="inp-sm"
              value={example.why}
              onChange={(e) => update({ why: e.target.value })}
              aria-label="Why it passes"
              placeholder="Why it passes"
            />
          </div>
        )}
      />
    </div>
  );
}
