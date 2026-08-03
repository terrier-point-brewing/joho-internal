"use client";

// Releases workbench — the frame that runs a beer release. Left: the release
// list. Right: the selected release's frame — header (name, status, S# | E#)
// and one card per registered component. The registry below is the ONLY
// place that knows which components make up a release; apparel, merch, and
// marketing land later as new entries here.

import { useState } from "react";
import PageHeader from "@/app/components/PageHeader";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import { releaseReadiness, type BrandRelease } from "@/lib/brand/releases";
import type { ReleaseGuide } from "@/lib/brand/releaseGuide";
import {
  useRecipePackagingVariationsQuery,
  useRecipesQuery,
} from "@/app/production/hooks/queries";
import { useSeasons } from "../templates/useTemplates";
import { useLabels } from "./useLabels";
import {
  useArchiveRelease,
  useCreateRelease,
  useMarkReleased,
  useReleases,
} from "./useReleases";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { recipeComponent } from "./RecipeComponent";
import { cardComponent } from "./CardComponent";
import { codesComponent } from "./CodesComponent";
import { labelComponent } from "./LabelComponent";
import { ReleaseStatusBadge, StatusChip } from "./bits";

// The release formula, in the order a release is made: prove the liquid,
// write the card, register the codes, make the label. New components append
// here.
const RELEASE_COMPONENTS: ReleaseComponentDef[] = [
  recipeComponent,
  cardComponent,
  codesComponent,
  labelComponent,
];

export default function ReleasesWorkbench({
  guide,
  description,
  homage,
}: {
  guide: ReleaseGuide;
  description: string;
  homage: string;
}) {
  const { data: releases = [], isLoading, error } = useReleases();
  const createRelease = useCreateRelease();
  const { data: seasons = [] } = useSeasons();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const selected = releases.find((r) => r.id === selectedId) ?? null;
  const seasonName = (id: string | null) => seasons.find((s) => s.id === id)?.name ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8 pb-4 border-b border-line">
        <PageHeader title="Releases" description={description} />
      </div>
      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-4 sm:pb-8 pt-4">
      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4">
        {/* List + create */}
        <div className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              createRelease.mutate(
                { name: newName.trim() },
                { onSuccess: (release) => { setSelectedId(release.id); setNewName(""); } },
              );
            }}
          >
            <input
              className="inp-sm"
              placeholder="New release name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" className="btn-primary btn-xxs" disabled={createRelease.isPending}>
              Add
            </button>
          </form>

          {isLoading && <p className="text-xs text-secondary">Loading…</p>}
          {error && <Banner tone="danger">{(error as Error).message}</Banner>}

          <div className="flex flex-col gap-2">
            {releases.map((release) => (
              <button
                key={release.id}
                type="button"
                onClick={() => setSelectedId(release.id)}
                className={`text-left ${release.id === selectedId ? "ring-1 ring-accent rounded-lg" : ""}`}
              >
                <Card padding="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-primary truncate">{release.name}</span>
                    <ReleaseStatusBadge status={release.status} />
                  </div>
                  {release.season_id && release.episode && (
                    <p className="text-2xs text-muted truncate">
                      {seasonName(release.season_id) ?? "Season"} · Episode {release.episode}
                    </p>
                  )}
                </Card>
              </button>
            ))}
            {releases.length === 0 && !isLoading && (
              <p className="text-xs text-muted">No releases yet.</p>
            )}
          </div>
        </div>

        {/* Frame */}
        {selected ? (
          <ReleaseFrame key={selected.id} release={selected} guide={guide} homage={homage} />
        ) : (
          <Card>
            <p className="text-sm text-secondary">Select a release, or add one to begin.</p>
          </Card>
        )}
      </div>
      </div>
    </div>
  );
}

function ReleaseFrame({
  release,
  guide,
  homage,
}: {
  release: BrandRelease;
  guide: ReleaseGuide;
  homage: string;
}) {
  const { data: labels = [] } = useLabels();
  const { data: seasons = [] } = useSeasons();
  const { data: allVariationLinks = [] } = useRecipePackagingVariationsQuery();
  // The frame reads the recipe too, not just the Recipe editor: its style and
  // ABV decide that card's chip, and therefore whether this release can publish.
  const { data: recipes = [] } = useRecipesQuery();
  const markReleased = useMarkReleased();
  const archiveRelease = useArchiveRelease();
  const [activeKey, setActiveKey] = useState<string>(RELEASE_COMPONENTS[0].key);

  const label = labels.find((l) => l.release_id === release.id) ?? null;
  const season = seasons.find((s) => s.id === release.season_id) ?? null;
  const recipe = recipes.find((r) => r.id === release.recipe_id) ?? null;
  const containers = release.recipe_id
    ? allVariationLinks.filter((l) => l.recipe_id === release.recipe_id)
    : [];

  const ctx: ReleaseComponentContext = { release, label, recipe, guide, homage, containers };
  const statuses = RELEASE_COMPONENTS.map((c) => c.status(ctx));
  const readyCount = statuses.filter((s) => s === "done").length;
  const active = RELEASE_COMPONENTS.find((c) => c.key === activeKey) ?? RELEASE_COMPONENTS[0];

  // The same pure rollup the API route runs before it will flip the status, so
  // the disabled button and the server's refusal can never disagree.
  const { ready, outstanding } = releaseReadiness({ release, recipe, containers, label });

  return (
    <div className="flex flex-col gap-3 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-base font-medium text-primary truncate">{release.name}</h2>
          <ReleaseStatusBadge status={release.status} />
          {season && release.episode && (
            <Badge tone="neutral">{season.name} · E{release.episode}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs ${readyCount === RELEASE_COMPONENTS.length ? "text-success" : "text-muted"}`}>
            {readyCount}/{RELEASE_COMPONENTS.length} components ready
          </span>
          <button className="btn-secondary btn-xxs" onClick={() => archiveRelease.mutate(release.id)}>
            Archive
          </button>
          {release.status === "draft" && (
            <button
              className="btn-primary btn-xxs"
              disabled={!ready || markReleased.isPending}
              onClick={() => markReleased.mutate(release.id)}
              title={ready ? undefined : `Outstanding: ${outstanding.join(", ")}`}
            >
              Publish release
            </button>
          )}
        </div>
      </div>

      {markReleased.error && <Banner tone="danger">{(markReleased.error as Error).message}</Banner>}

      {/* Component cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {RELEASE_COMPONENTS.map((c, i) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActiveKey(c.key)}
            className={`text-left ${c.key === active.key ? "ring-1 ring-accent rounded-lg" : ""}`}
          >
            <Card padding="p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-medium text-primary">{c.title}</span>
                <StatusChip status={statuses[i]} />
              </div>
              <p className="text-2xs text-muted">{c.blurb}</p>
              <p className="text-2xs text-secondary mt-1 truncate">{c.summary(ctx)}</p>
            </Card>
          </button>
        ))}
      </div>

      {/* Active component editor */}
      <Card>
        <active.Editor ctx={ctx} />
      </Card>
    </div>
  );
}
