// The release frame's component contract. A release is executed by finishing
// a set of components; the frame itself doesn't know what they are — it
// renders whatever defs are registered in ReleasesWorkbench and rolls up
// their status chips. Adding a component later (apparel, merch, marketing)
// means writing one module that exports a ReleaseComponentDef and adding it
// to the registry — the spine and the other components never change.

import type { ComponentType } from "react";
import type { BrandRelease, ComponentStatus } from "@/lib/brand/releases";
import type { BrandLabel } from "@/lib/brand/labels";
import type { RecipePackagingVariation } from "@/app/production/types";

/** Canon copy the artist-brief composer quotes. Server-resolved in page.tsx. */
export interface BriefContext {
  chassisNarrative: string;
  homage: string;
}

/** Everything a component can see. Editors fetch their own extra data
 * (recipes, seasons, assets) via hooks so the context stays lean. */
export interface ReleaseComponentContext {
  release: BrandRelease;
  /** The 1:1 label component row, once loaded. */
  label: BrandLabel | null;
  /** Published canon's naming criteria. */
  criteria: string[];
  brief: BriefContext;
  /** The linked recipe's packaging-variation links (empty until a recipe is
   * linked). Shared context because several components read them: Product
   * Codes edits them, Label warns off them. */
  containers: RecipePackagingVariation[];
}

export interface ReleaseComponentDef {
  key: string;
  title: string;
  blurb: string;
  status(ctx: ReleaseComponentContext): ComponentStatus;
  /** One line under the title on the card face. */
  summary(ctx: ReleaseComponentContext): string;
  Editor: ComponentType<{ ctx: ReleaseComponentContext }>;
}
