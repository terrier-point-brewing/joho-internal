// The release frame's component contract. A release is executed by finishing
// a set of components; the frame itself doesn't know what they are — it
// renders whatever defs are registered in ReleasesWorkbench and rolls up
// their status chips. Adding a component later (apparel, merch, marketing)
// means writing one module that exports a ReleaseComponentDef and adding it
// to the registry — the spine and the other components never change.

import type { ComponentType } from "react";
import type { BrandRelease, ComponentStatus, ReleaseComponentKey } from "@/lib/brand/releases";
import type { ReleaseGuide } from "@/lib/brand/releaseGuide";
import type { BrandLabel } from "@/lib/brand/labels";
import type { Recipe, RecipePackagingVariation } from "@/app/production/types";

/** Everything a component can see. Editors fetch their own extra data
 * (recipes, seasons, assets) via hooks so the context stays lean. */
export interface ReleaseComponentContext {
  release: BrandRelease;
  /** The 1:1 label component row, once loaded. */
  label: BrandLabel | null;
  /** The linked Production recipe, once loaded — null until one is linked (or
   * while the recipes query is in flight). Its style/ABV gate the Recipe card,
   * so the frame reads it rather than only the editor. */
  recipe: Recipe | null;
  /** The Brand Guide's copy for each card, resolved from the published canon
   * in page.tsx. Components render this; they never hold guide prose of their
   * own. See lib/brand/releaseGuide.ts. */
  guide: ReleaseGuide;
  /** The linked recipe's packaging-variation links (empty until a recipe is
   * linked). Shared context because several components read them: Product
   * Codes edits them, Label warns off them. */
  containers: RecipePackagingVariation[];
}

export interface ReleaseComponentDef {
  /** Keyed to RELEASE_COMPONENT_TITLES so the cards, the publish gate's
   *  "outstanding" list, and the guide mapping all name the same four things. */
  key: ReleaseComponentKey;
  title: string;
  blurb: string;
  status(ctx: ReleaseComponentContext): ComponentStatus;
  /** One line under the title on the card face. */
  summary(ctx: ReleaseComponentContext): string;
  Editor: ComponentType<{ ctx: ReleaseComponentContext }>;
}
