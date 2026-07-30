"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type Slider = BrandCanon["voice"]["sliders"][number];
type Rewrite = BrandCanon["voice"]["rewrites"][number];

/** Comma-separated word list — the shape both vocabulary lists take. */
function WordListField({
  label,
  description,
  words,
  onChange,
}: {
  label: string;
  description: string;
  words: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      <span className="text-xs text-faint">{description}</span>
      <input
        className="inp"
        value={words.join(", ")}
        // Split on commit rather than filtering as you type — filtering empties
        // mid-edit would delete the separator the moment you typed it.
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((w) => w.trim())
              .filter(Boolean),
          )
        }
      />
    </label>
  );
}

/** Typed editor for the whole Voice slice — replaces the raw-JSON editor. */
export default function VoiceFields({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const setVoice = (patch: Partial<BrandCanon["voice"]>) =>
    onChange({ ...draft, voice: { ...draft.voice, ...patch } });

  return (
    <div className="flex flex-col gap-6">
      <ListField<Slider>
        label="Calibration"
        description="Each axis, where the voice sits on it (0–100 toward the right pole), and what that means."
        addLabel="Add axis"
        items={draft.voice.sliders}
        onChange={(sliders) => setVoice({ sliders })}
        blank={() => ({ id: crypto.randomUUID(), left: "", right: "", pos: 50, note: "" })}
        renderItem={(slider, update) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                className="inp-sm flex-1"
                value={slider.left}
                onChange={(e) => update({ left: e.target.value })}
                aria-label="Left pole"
                placeholder="Left pole"
              />
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                className="flex-1"
                value={slider.pos}
                onChange={(e) => update({ pos: Number(e.target.value) })}
                aria-label="Position"
              />
              <input
                className="inp-sm flex-1"
                value={slider.right}
                onChange={(e) => update({ right: e.target.value })}
                aria-label="Right pole"
                placeholder="Right pole"
              />
              <span className="text-sm tabular-nums text-secondary w-8 text-right shrink-0">
                {slider.pos}
              </span>
            </div>
            <input
              className="inp-sm"
              value={slider.note}
              onChange={(e) => update({ note: e.target.value })}
              aria-label="Note"
              placeholder="What this calibration means in practice"
            />
          </div>
        )}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <WordListField
          label="Lean on"
          description="Comma-separated."
          words={draft.voice.leanOnWords}
          onChange={(leanOnWords) => setVoice({ leanOnWords })}
        />
        <WordListField
          label="Never"
          description="Comma-separated. One of these puts copy off-voice on its own."
          words={draft.voice.neverWords}
          onChange={(neverWords) => setVoice({ neverWords })}
        />
      </div>

      <ListField<Rewrite>
        label="In practice"
        description="The same message written on-voice and off-voice."
        addLabel="Add example"
        items={draft.voice.rewrites}
        onChange={(rewrites) => setVoice({ rewrites })}
        blank={() => ({ id: crypto.randomUUID(), context: "", on: "", off: "" })}
        renderItem={(rewrite, update) => (
          <div className="flex flex-col gap-2">
            <input
              className="inp-sm"
              value={rewrite.context}
              onChange={(e) => update({ context: e.target.value })}
              aria-label="Context"
              placeholder="Context — where this copy appears"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-2xs uppercase tracking-wide text-success">On-voice</span>
                <textarea
                  className="inp min-h-16 text-sm"
                  value={rewrite.on}
                  onChange={(e) => update({ on: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-2xs uppercase tracking-wide text-danger">Off-voice</span>
                <textarea
                  className="inp min-h-16 text-sm"
                  value={rewrite.off}
                  onChange={(e) => update({ off: e.target.value })}
                />
              </label>
            </div>
          </div>
        )}
      />
    </div>
  );
}
