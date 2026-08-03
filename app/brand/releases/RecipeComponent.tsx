"use client";

// Beer Recipe component — a LINK to Production, not a copy. Once a recipe is
// picked, the card shows read-only facts pulled live from Production (name,
// style, ABV, containers, product codes). Brand never edits these; the
// single source of truth stays in Production → Recipes.

import { useState } from "react";
import Link from "next/link";
import Banner from "@/app/components/ui/Banner";
import { useRecipesQuery } from "@/app/production/hooks/queries";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { RELEASE_COMPONENT_TITLES, recipeComponentStatus, recipeGaps } from "@/lib/brand/releases";
import { useUpdateRelease } from "./useReleases";
import { Field } from "./bits";
import GuidePanel from "./GuidePanel";

/** Opens this recipe in Production → Recipes with its row already expanded. */
function productionHref(recipeId: string) {
  return `/production/recipes?recipe=${recipeId}`;
}

function RecipeEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release, recipe, containers } = ctx;
  // The picker needs the whole catalog; the linked row itself comes from ctx,
  // where the frame already resolved it. react-query dedupes the fetch.
  const { data: recipes = [], isLoading } = useRecipesQuery();
  const updateRelease = useUpdateRelease();
  const [pickedId, setPickedId] = useState("");

  if (!release.recipe_id) {
    return (
      <div className="flex flex-col gap-3 max-w-lg">
        <GuidePanel entry={ctx.guide.recipe} />
        <p className="text-sm text-secondary">
          A release is fundamentally a new recipe we&apos;ve tested and can produce. Link the
          Production recipe this release pours.
        </p>
        <Field label="Recipe">
          <select className="inp" value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
            <option value="">{isLoading ? "Loading recipes…" : "— select a recipe —"}</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>{r.beer_name}</option>
            ))}
          </select>
        </Field>
        <button
          className="btn-primary btn-xxs self-start"
          disabled={!pickedId || updateRelease.isPending}
          onClick={() => updateRelease.mutate({ id: release.id, patch: { recipe_id: pickedId } })}
        >
          Link recipe
        </button>
        {updateRelease.error && <Banner tone="danger">{(updateRelease.error as Error).message}</Banner>}
      </div>
    );
  }

  const gaps = recipeGaps(recipe, containers);

  return (
    <div className="flex flex-col gap-3">
      <GuidePanel entry={ctx.guide.recipe} />

      {gaps.length > 0 && (
        <Banner tone="info">
          Not ready to pour yet — Production still needs {gaps.join(", ")}. Set{" "}
          {gaps.length === 1 ? "it" : "them"} on the recipe and this card turns ready.
        </Banner>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 max-w-xl">
        <Fact label="Beer name" value={recipe?.beer_name ?? "…"} />
        <Fact
          label="Beer style"
          value={recipe?.style ?? "— not set in Production yet"}
          muted={!recipe?.style}
        />
        <Fact label="ABV" value={recipe?.abv != null ? `${recipe.abv}%` : "— not set in Production yet"} muted={recipe?.abv == null} />
        <Fact
          label="Expected yield"
          value={recipe?.expected_yield_bbl != null ? `${recipe.expected_yield_bbl} BBL / turn` : "—"}
        />
      </div>

      <div>
        <p className="text-xs text-secondary mb-1">Containers</p>
        {containers.length === 0 ? (
          <p className="text-xs text-muted">
            No packaging variations on this recipe yet — they&apos;re defined in Production →
            Recipes, usually after the release card is written.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {containers.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 text-sm max-w-xl">
                <span className="text-body truncate">{l.packaging_variations?.name ?? "—"}</span>
                <span className="text-xs text-muted tabular-nums">
                  {l.packaging_variations?.total_volume_fl_oz != null
                    ? `${l.packaging_variations.total_volume_fl_oz} fl oz`
                    : ""}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted">Codes for these containers live on the Product Codes card.</p>
          </div>
        )}
      </div>

      <p className="text-xs text-muted">
        Name, style, ABV and variations are owned by Production → Recipes; edit them there
        and they update here.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <Link className="btn-secondary btn-xxs" href={productionHref(release.recipe_id)}>
          Edit in Production →
        </Link>
        <button
          className="btn-secondary btn-xxs"
          disabled={updateRelease.isPending}
          onClick={() => updateRelease.mutate({ id: release.id, patch: { recipe_id: null } })}
        >
          Unlink recipe
        </button>
      </div>
    </div>
  );
}

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-secondary">{label}</span>
      <span className={`text-sm ${muted ? "text-faint" : "text-body"}`}>{value}</span>
    </div>
  );
}

export const recipeComponent: ReleaseComponentDef = {
  key: "recipe",
  title: RELEASE_COMPONENT_TITLES.recipe,
  blurb: "The liquid — linked from Production.",
  status: (ctx) => recipeComponentStatus(ctx.release, ctx.recipe, ctx.containers),
  summary: (ctx) => {
    if (!ctx.release.recipe_id) return "No recipe linked yet";
    const gaps = recipeGaps(ctx.recipe, ctx.containers);
    return gaps.length ? `Missing ${gaps.join(", ")}` : "Style, ABV and a can are set";
  },
  Editor: RecipeEditor,
};
