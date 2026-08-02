"use client";

// Release Card component — the release's identity, mirroring the brand
// guide's "Writing a release card" template: name, story line, menu
// description, checked against the canon's naming gates, plus the release's
// place in a season (S# | E#). Fields live on the release row itself.

import { useMemo, useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { syncNamingCheck, type NamingCheck } from "@/lib/brand/labels";
import { cardComponentStatus, type BrandRelease } from "@/lib/brand/releases";
import { useSeasons } from "../templates/useTemplates";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { useUpdateRelease } from "./useReleases";
import { Field } from "./bits";

function CardEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release, criteria } = ctx;
  const { data: seasons = [] } = useSeasons();
  const updateRelease = useUpdateRelease();

  const [draft, setDraft] = useState<BrandRelease>(release);
  const set = (patch: Partial<BrandRelease>) => setDraft((d) => ({ ...d, ...patch }));

  // Keep the naming check aligned with the current canon criteria.
  const namingResults = useMemo(
    () => syncNamingCheck(criteria, draft.naming_check ?? { results: [] }).results,
    [criteria, draft.naming_check],
  );
  const setNaming = (results: NamingCheck["results"]) => set({ naming_check: { results } });

  // Draft + active seasons are assignable; archived ones only appear when the
  // release already points at them (so old releases keep their badge).
  const assignableSeasons = seasons.filter(
    (s) => s.status !== "archived" || s.id === draft.season_id,
  );

  return (
    <div className="flex flex-col gap-4">
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

      <div>
        <p className="text-xs text-secondary mb-2">Naming check</p>
        {criteria.length === 0 && <p className="text-xs text-muted">No naming criteria in the canon.</p>}
        <div className="flex flex-col gap-3">
          {namingResults.map((r, i) => (
            <div key={r.criterion} className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={r.pass}
                onChange={(e) => {
                  const next = [...namingResults];
                  next[i] = { ...r, pass: e.target.checked };
                  setNaming(next);
                }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-body">{r.criterion}</p>
                <input
                  className="inp-sm mt-1"
                  placeholder="Note (optional)"
                  value={r.note ?? ""}
                  onChange={(e) => {
                    const next = [...namingResults];
                    next[i] = { ...r, note: e.target.value };
                    setNaming(next);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
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
              naming_check: { results: namingResults },
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
  title: "Release Card",
  blurb: "Name, story, menu line, season & episode.",
  status: (ctx) => cardComponentStatus(ctx.release, ctx.criteria),
  summary: (ctx) => {
    const parts: string[] = [];
    if (ctx.release.episode && ctx.release.season_id) parts.push(`Episode ${ctx.release.episode}`);
    const passed = (ctx.release.naming_check?.results ?? []).filter((r) => r.pass).length;
    if (ctx.criteria.length > 0) parts.push(`${passed}/${ctx.criteria.length} naming gates`);
    return parts.length ? parts.join(" · ") : "Card not written yet";
  },
  Editor: CardEditor,
};
