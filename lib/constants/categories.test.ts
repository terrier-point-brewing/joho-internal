import { describe, it, expect } from "vitest";
import {
  CATEGORY_IDS,
  CONTRACT_BREWING_SUBCATEGORY_LABELS,
  classifyContractBrewingItem,
  TAPROOM_MODEL_CATEGORIES,
} from "./categories";

describe("CATEGORY_IDS", () => {
  it("exposes Sets keyed by business meaning", () => {
    expect(CATEGORY_IDS.DRAFT).toBeInstanceOf(Set);
    expect(CATEGORY_IDS.DRAFT.has("567KQPEBRBZHG7ATHQFRCRWZ")).toBe(true);
    expect(CATEGORY_IDS.DRAFT.has("DCPYMNVDYNX4JAFI22DMVKLN")).toBe(true);
  });

  it("pairs main + Holly Springs ids for paired categories", () => {
    expect(CATEGORY_IDS.KEGS.size).toBe(2);
    expect(CATEGORY_IDS.MERCHANDISE.size).toBe(2);
  });

  it("keeps single-location categories as one-element sets", () => {
    expect(CATEGORY_IDS.WINE.size).toBe(1);
    expect(CATEGORY_IDS.CONTRACT_BREWING.has("CDX2UMLF35B4I3F7ILYLMWMF")).toBe(true);
  });

  it("misses for an unknown id", () => {
    expect(CATEGORY_IDS.DRAFT.has("not-a-real-id")).toBe(false);
  });
});

describe("classifyContractBrewingItem", () => {
  it("routes ingredient deposit to MATERIALS_PACKAGING", () => {
    expect(classifyContractBrewingItem("Ingredient Deposit")).toBe("MATERIALS_PACKAGING");
  });

  it("routes packaging material to MATERIALS_PACKAGING", () => {
    expect(classifyContractBrewingItem("Packaging Material — 12oz cans")).toBe(
      "MATERIALS_PACKAGING",
    );
  });

  it("routes packaging fee to PACKAGING_FEES", () => {
    expect(classifyContractBrewingItem("Packaging Fee")).toBe("PACKAGING_FEES");
  });

  it("routes excise tax to PASS_THROUGH_TAXES", () => {
    expect(classifyContractBrewingItem("Excise Tax")).toBe("PASS_THROUGH_TAXES");
  });

  it("routes any item containing 'tax' to PASS_THROUGH_TAXES", () => {
    expect(classifyContractBrewingItem("Sales Tax")).toBe("PASS_THROUGH_TAXES");
  });

  it("falls back to OTHER_SERVICES for unmatched items", () => {
    expect(classifyContractBrewingItem("Keg Cleaning")).toBe("OTHER_SERVICES");
    expect(classifyContractBrewingItem("Forklift Rental")).toBe("OTHER_SERVICES");
    expect(classifyContractBrewingItem("Transfer Payment")).toBe("OTHER_SERVICES");
  });

  it("is case-insensitive", () => {
    expect(classifyContractBrewingItem("INGREDIENT DEPOSIT")).toBe("MATERIALS_PACKAGING");
    expect(classifyContractBrewingItem("packaging fee")).toBe("PACKAGING_FEES");
  });

  it("handles an empty string as OTHER_SERVICES", () => {
    expect(classifyContractBrewingItem("")).toBe("OTHER_SERVICES");
  });

  // The materials check runs before the tax check, so 'packaging material'
  // wins even though the string also doesn't contain 'tax'. Documenting that a
  // 'packaging fee' string containing 'tax' would still route to taxes only if
  // it doesn't first hit an earlier rule.
  it("applies rules in priority order (materials before packaging fee)", () => {
    // "packaging material fee" contains both "packaging material" and "packaging fee";
    // materials is checked first.
    expect(classifyContractBrewingItem("Packaging Material Fee")).toBe("MATERIALS_PACKAGING");
  });
});

describe("CONTRACT_BREWING_SUBCATEGORY_LABELS", () => {
  it("has a human label for every subcategory", () => {
    expect(CONTRACT_BREWING_SUBCATEGORY_LABELS.MATERIALS_PACKAGING).toBe("Materials & Packaging");
    expect(CONTRACT_BREWING_SUBCATEGORY_LABELS.PACKAGING_FEES).toBe("Packaging Fees");
    expect(CONTRACT_BREWING_SUBCATEGORY_LABELS.OTHER_SERVICES).toBe("Other Services");
    expect(CONTRACT_BREWING_SUBCATEGORY_LABELS.PASS_THROUGH_TAXES).toBe("Pass-Through Taxes");
  });

  it("has a label for each value classifyContractBrewingItem can return", () => {
    const returned = [
      classifyContractBrewingItem("Ingredient Deposit"),
      classifyContractBrewingItem("Packaging Fee"),
      classifyContractBrewingItem("Excise Tax"),
      classifyContractBrewingItem("Keg Cleaning"),
    ];
    for (const key of returned) {
      expect(CONTRACT_BREWING_SUBCATEGORY_LABELS[key]).toBeTruthy();
    }
  });
});

describe("TAPROOM_MODEL_CATEGORIES", () => {
  it("lists exactly the expected report categories", () => {
    const ids = TAPROOM_MODEL_CATEGORIES.map((c) => c.id);
    expect(ids).toEqual([
      "DRAFT_BEER",
      "LIQUOR",
      "WINE_CIDER_SELTZER",
      "COCKTAILS",
      "NA_SNACKS",
      "KEGS",
      "CANS",
      "MERCHANDISE",
      "CO2",
      "OTHER",
    ]);
  });

  it("rolls all six liquor categories into LIQUOR", () => {
    const liquor = TAPROOM_MODEL_CATEGORIES.find((c) => c.id === "LIQUOR");
    expect(liquor?.squareCats).toEqual(
      expect.arrayContaining([
        ...CATEGORY_IDS.BOURBON,
        ...CATEGORY_IDS.TEQUILA,
        ...CATEGORY_IDS.RUM,
        ...CATEGORY_IDS.VODKA,
        ...CATEGORY_IDS.GIN,
        ...CATEGORY_IDS.WHISKEY,
      ]),
    );
  });

  it("maps CO2 to the tank-fills category", () => {
    const co2 = TAPROOM_MODEL_CATEGORIES.find((c) => c.id === "CO2");
    expect(co2?.squareCats).toEqual([...CATEGORY_IDS.TANK_FILLS]);
  });

  it("gives every category a non-empty label", () => {
    for (const c of TAPROOM_MODEL_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});
