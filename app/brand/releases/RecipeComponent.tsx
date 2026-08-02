"use client";

// Beer Recipe component — a LINK to Production, not a copy. Once a recipe is
// picked, the card shows read-only facts pulled live from Production (name,
// style, ABV, containers, product codes). Brand never edits these; the
// single source of truth stays in Production → Recipes.

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { useRecipesQuery } from "@/app/production/hooks/queries";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { recipeComponentStatus } from "@/lib/brand/releases";
import { useUpdateRelease } from "./useReleases";
import { Field } from "./bits";

function RecipeEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release, containers } = ctx;
  const { data: recipes = [], isLoading } = useRecipesQuery();
  const updateRelease = useUpdateRelease();
  const [pickedId, setPickedId] = useState("");

  const recipe = recipes.find((r) => r.id === release.recipe_id) ?? null;

  if (!release.recipe_id) {
    return (
      <div className="flex flex-col gap-3 max-w-lg">
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

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 max-w-xl">
        <Fact label="Beer name" value={recipe?.beer_name ?? "…"} />
        <Fact label="Beer style" value={recipe ? (recipe.style ?? recipe.beer_name) : "…"} />
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
      <button
        className="btn-secondary btn-xxs self-start"
        disabled={updateRelease.isPending}
        onClick={() => updateRelease.mutate({ id: release.id, patch: { recipe_id: null } })}
      >
        Unlink recipe
      </button>
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
  title: "Beer Recipe",
  blurb: "The liquid — linked from Production.",
  status: (ctx) => recipeComponentStatus(ctx.release),
  summary: (ctx) => (ctx.release.recipe_id ? "Recipe linked" : "No recipe linked yet"),
  Editor: RecipeEditor,
};
