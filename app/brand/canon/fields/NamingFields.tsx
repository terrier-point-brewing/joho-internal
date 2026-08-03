"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Example = BrandCanon["naming"]["passingExamples"][number];
type Narrative = BrandCanon["naming"]["narrative"];

const BLANK_NARRATIVE: Narrative = {
  intro: "",
  name: "",
  story: "",
  menuDescription: "",
  why: "",
  footer: "",
};

// The narrative's slots, labelled as the Voice tab labels them. Order matches
// the card: intro above it, four fields inside it, the aloud test at its foot.
const NARRATIVE_FIELDS: { key: keyof Narrative; label: string; hint: string }[] = [
  { key: "intro", label: "Intro line", hint: "One sentence above the template card." },
  { key: "name", label: "Name", hint: "What the name must do." },
  { key: "story", label: "Story line", hint: "What the story line must do." },
  { key: "menuDescription", label: "Menu description", hint: "What the menu line must do." },
  { key: "why", label: "Why it passes", hint: "What the internal verdict must do." },
  { key: "footer", label: "Closing test", hint: "The line at the foot of the card." },
];

/**
 * Editor for the naming law — the release-card template, the five criteria, and
 * the examples that pass them.
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
    narrative: BLANK_NARRATIVE,
    criteria: ["", "", "", "", ""],
    passingExamples: [],
  };

  // A document written before migration 20260912090000 holds a string here.
  const narrative =
    naming.narrative && typeof naming.narrative === "object" ? naming.narrative : BLANK_NARRATIVE;

  function setNarrative(key: keyof Narrative, text: string) {
    onChange({ ...draft, naming: { ...naming, narrative: { ...narrative, [key]: text } } });
  }

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
      <div className="flex flex-col gap-2">
        <div>
          <span className="text-2xs uppercase tracking-wide text-muted">Release card</span>
          <p className="text-2xs text-faint mt-0.5">
            The instruction for each line of a release card. The guide renders these as a template
            card above the passing examples, under the same labels.
          </p>
        </div>
        {NARRATIVE_FIELDS.map((field) => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-2xs uppercase tracking-wide text-muted">{field.label}</span>
            <textarea
              className="inp min-h-16 text-sm"
              value={narrative[field.key] ?? ""}
              onChange={(e) => setNarrative(field.key, e.target.value)}
              placeholder={field.hint}
            />
          </label>
        ))}
      </div>

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
            <span className="text-xs w-8 shrink-0 grid place-items-center text-muted">{i + 1}</span>
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
        blank={() => ({ storyTitle: "", beerStyle: "", story: "", menuDescription: "", why: "" })}
        renderItem={(example, update) => (
          <div className="flex flex-col gap-2">
            {/* Two inputs, not one string with an em dash in the middle: the
                name pattern is Story Title — Beer Style, and typing it into a
                single box left the halves unenforceable (and the guide with a
                "Naming pattern" line whose only job was to restate them). */}
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="inp-sm"
                value={example.storyTitle}
                onChange={(e) => update({ storyTitle: e.target.value })}
                aria-label="Story title"
                placeholder="Story title — Peach Blossom Spring"
              />
              <input
                className="inp-sm"
                value={example.beerStyle}
                onChange={(e) => update({ beerStyle: e.target.value })}
                aria-label="Beer style"
                placeholder="Beer style — Jasmine Peach Lager"
              />
            </div>
            <textarea
              className="inp min-h-16 text-sm"
              value={example.story}
              onChange={(e) => update({ story: e.target.value })}
              aria-label="Story line"
              placeholder="Story line — the moment or story the name points to"
            />
            <input
              className="inp-sm"
              value={example.menuDescription}
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
