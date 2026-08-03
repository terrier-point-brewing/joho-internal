"use client";

// Product Codes component — one code per sellable container. Sequencing is
// the whole point of this card: variations are defined in Production AFTER
// the release card is written, and each container's code is registered here
// AFTER its variation exists — the label's barcode needs it before the print
// order goes out. The codes live on Production's recipe↔variation links
// (single source of truth); this card is just the edit surface at the moment
// in the release where registering them is the actual job.

import { useQueryClient } from "@tanstack/react-query";
import { productionKeys } from "@/app/production/hooks/queries";
import ProductCodeInput from "@/app/production/components/ProductCodeInput";
import { RELEASE_COMPONENT_TITLES, codesComponentStatus } from "@/lib/brand/releases";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import GuidePanel from "./GuidePanel";

function CodesEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release, containers } = ctx;
  const qc = useQueryClient();

  if (!release.recipe_id) {
    return (
      <>
        <GuidePanel entry={ctx.guide.codes} />
        <p className="text-sm text-secondary">
          Link a recipe on the Beer Recipe card first — codes attach to that recipe&apos;s
          containers.
        </p>
      </>
    );
  }

  if (containers.length === 0) {
    return (
      <>
        <GuidePanel entry={ctx.guide.codes} />
        <p className="text-sm text-secondary">
          No packaging variations on this recipe yet. They&apos;re defined in Production →
          Recipes, usually once the release card is written; each container then gets its
          code registered here.
        </p>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-w-xl">
      <GuidePanel entry={ctx.guide.codes} />
      <p className="text-xs text-muted">
        Register the code for each sellable container (a 4-pack and a keg carry different
        codes). The label&apos;s barcode needs these before the print order goes out.
      </p>
      <div className="flex flex-col gap-1.5">
        {containers.map((l) => (
          <div key={l.id} className="flex items-center justify-between gap-3 text-sm flex-wrap">
            <span className="text-body truncate">{l.packaging_variations?.name ?? "—"}</span>
            <ProductCodeInput
              link={l}
              onSaved={() => qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations })}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        Codes are stored on Production&apos;s recipe↔packaging links — editing here and in
        Production → Recipes is the same field.
      </p>
    </div>
  );
}

export const codesComponent: ReleaseComponentDef = {
  key: "codes",
  title: RELEASE_COMPONENT_TITLES.codes,
  blurb: "One code per sellable container.",
  status: (ctx) => codesComponentStatus(Boolean(ctx.release.recipe_id), ctx.containers),
  summary: (ctx) => {
    if (!ctx.release.recipe_id) return "Waiting on Beer Recipe";
    if (ctx.containers.length === 0) return "Waiting on packaging variations";
    const coded = ctx.containers.filter((c) => c.product_code).length;
    return `${coded}/${ctx.containers.length} containers coded`;
  },
  Editor: CodesEditor,
};
