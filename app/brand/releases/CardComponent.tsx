"use client";

// Release Card component — the release's identity, mirroring the brand
// guide's "Writing a release card" template: name, story line, menu
// description, plus the release's place in a season (S# | E#). Fields live on
// the release row itself.
//
// The naming gates used to be five checkboxes here, and the card couldn't read
// "Ready" until every one was ticked — which meant it never did. They're a
// writer's test, not data, so they now render as the guide's own text in the
// panel above (lib/brand/releaseGuide.ts) and gate nothing.

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { RELEASE_COMPONENT_TITLES, cardComponentStatus, type BrandRelease } from "@/lib/brand/releases";
import { useSeasons } from "../templates/useTemplates";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { useUpdateRelease } from "./useReleases";
import { Field } from "./bits";
import GuidePanel from "./GuidePanel";

function CardEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release } = ctx;
  const { data: seasons = [] } = useSeasons();
  const updateRelease = useUpdateRelease();

  const [draft, setDraft] = useState<BrandRelease>(release);
  const set = (patch: Partial<BrandRelease>) => setDraft((d) => ({ ...d, ...patch }));

  // Draft + active seasons are assignable; archived ones only appear when the
  // release already points at them (so old releases keep their badge).
  const assignableSeasons = seasons.filter(
    (s) => s.status !== "archived" || s.id === draft.season_id,
  );

  return (
    <div className="flex flex-col gap-4">
      <GuidePanel entry={ctx.guide.card} />
      <div className="flex flex-col gap-3 max-w-lg">
        <Field label="Name">
          <input className="inp" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Story line">
          <textarea
            className="inp"
            rows={2}
            placeholder="One picturable image of a feeling — printed verbatim on the label."
            value={draft.story_line ?? ""}
            onChange={(e) => set({ story_line: e.target.value })}
          />
        </Field>
        <Field label="Menu description">
          <textarea
            className="inp"
            rows={2}
            placeholder="How it reads on the menu."
            value={draft.menu_description ?? ""}
            onChange={(e) => set({ menu_description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Season">
            <select
              className="inp"
              value={draft.season_id ?? ""}
              onChange={(e) => set({ season_id: e.target.value || null })}
            >
              <option value="">— none —</option>
              {assignableSeasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.status === "active" ? " (active)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Episode">
            <input
              type="number"
              min="1"
              step="1"
              className="inp"
              placeholder="e.g. 4"
              value={draft.episode ?? ""}
              onChange={(e) => set({ episode: e.target.value ? parseInt(e.target.value) : null })}
            />
          </Field>
        </div>
        {seasons.length === 0 && (
          <p className="text-xs text-muted">
            No seasons yet — create one under Brand → Templates → Seasons.
          </p>
        )}
      </div>

      {updateRelease.error && <Banner tone="danger">{(updateRelease.error as Error).message}</Banner>}
      <button
        className="btn-primary btn-xxs self-start"
        disabled={updateRelease.isPending}
        onClick={() =>
          updateRelease.mutate({
            id: release.id,
            patch: {
              name: draft.name,
              story_line: draft.story_line,
              menu_description: draft.menu_description,
              season_id: draft.season_id,
              episode: draft.episode,
            },
          })
        }
      >
        {updateRelease.isPending ? "Saving…" : "Save card"}
      </button>
    </div>
  );
}

export const cardComponent: ReleaseComponentDef = {
  key: "card",
  title: RELEASE_COMPONENT_TITLES.card,
  blurb: "Name, story, menu line, season & episode.",
  status: (ctx) => cardComponentStatus(ctx.release),
  summary: (ctx) => {
    const { release } = ctx;
    if (release.season_id && release.episode) return `Episode ${release.episode}`;
    if (release.story_line || release.menu_description) return "Needs a season & episode";
    return "Card not written yet";
  },
  Editor: CardEditor,
};
