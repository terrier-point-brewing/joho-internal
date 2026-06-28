import { describe, it, expect } from "vitest";
import { buildVariationLinkMatrix } from "./recipeLinkMatrix";
import type { RecipePackagingVariationExpanded, RecipeSquareLinkRow, Recipe } from "@/app/production/types";
import type { SquareCatalogOptions } from "@/app/production/types";

const recipes = [{ id: "r1", beer_name: "Epic Hazy IPA" } as Recipe];

const rpvs: RecipePackagingVariationExpanded[] = [
  {
    id: "rpv1", recipe_id: "r1", variation_id: "v1", created_at: "",
    packaging_variations: {
      id: "v1", container_id: "c16", format: "4-pack", partner_id: "p1",
      total_volume_fl_oz: 64, is_active: true,
      packaging_items: { id: "c16", name: "16oz Blank", type: "can", volume_fl_oz: 16 },
      contract_brewing_partners: { id: "p1", company_name: "Argus Beverage Ventures LLC" },
    },
  },
  {
    id: "rpv2", recipe_id: "r1", variation_id: "v2", created_at: "",
    packaging_variations: {
      id: "v2", container_id: "c16", format: "4-pack", partner_id: "p1",
      total_volume_fl_oz: 64, is_active: true,
      packaging_items: { id: "c16", name: "16oz Blank", type: "can", volume_fl_oz: 16 },
      contract_brewing_partners: { id: "p1", company_name: "Argus Beverage Ventures LLC" },
    },
  },
];

const catalog: SquareCatalogOptions = {
  items: [{ itemId: "i1", itemName: "Epic Hazy IPA", variations: [{ variationId: "sv1", variationName: "4-Pack" }] }],
  discounts: [],
};

describe("buildVariationLinkMatrix", () => {
  it("emits one row per recipe_packaging_variation even when container+format collide", () => {
    const groups = buildVariationLinkMatrix(rpvs, recipes, [], catalog);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.map((r) => r.variationId).sort()).toEqual(["v1", "v2"]);
  });

  it("marks a row linked when a link exists for its variation_id", () => {
    const links: RecipeSquareLinkRow[] = [{
      id: "l1", recipe_id: "r1", packaging: "can", variation_id: "v1",
      packaging_item_id: "c16",
      square_variation_id: "sv1", square_item_id: "i1",
      variation_name: "4-Pack", item_name: "Epic Hazy IPA", created_at: "",
    }];
    const groups = buildVariationLinkMatrix(rpvs, recipes, links, catalog);
    const v1 = groups.flatMap((g) => g.rows).find((r) => r.variationId === "v1");
    const v2 = groups.flatMap((g) => g.rows).find((r) => r.variationId === "v2");
    expect(v1?.state).toBe("linked");
    expect(v1?.linkId).toBe("l1");
    expect(v2?.state).not.toBe("linked");
  });

  it("groups by partner", () => {
    const groups = buildVariationLinkMatrix(rpvs, recipes, [], catalog);
    expect(groups.length).toBe(1);
    expect(groups[0].partnerName).toBe("Argus Beverage Ventures LLC");
  });
});
