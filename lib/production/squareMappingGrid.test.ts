// lib/production/squareMappingGrid.test.ts
import { describe, it, expect } from "vitest";
import { autoSuggest, deriveColumns, buildGrid } from "./squareMappingGrid";
import type { RpvRow, SquareCatalogVariationFlat, LinkRow } from "./squareMappingGrid";

// ── autoSuggest ───────────────────────────────────────────────────────────────

const sqVars: SquareCatalogVariationFlat[] = [
  { squareVariationId: "sv1", squareItemId: "si1", itemName: "Epic Hazy IPA", variationName: "4-Pack", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  { squareVariationId: "sv2", squareItemId: "si2", itemName: "Epic Hazy IPA", variationName: "Loose", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  { squareVariationId: "sv3", squareItemId: "si3", itemName: "Some Other Beer", variationName: "1/2 BBL", categoryName: "Kegs", volumeFlOzPerUnit: 1984 },
  { squareVariationId: "sv4", squareItemId: "si4", itemName: "Epic Hazy", variationName: "Case", categoryName: "Cans", volumeFlOzPerUnit: 12 },
];

describe("autoSuggest", () => {
  it("returns high-confidence when volume matches and name tokens overlap", () => {
    // +4 volume + +3 name + +1 format = 8 → high
    const result = autoSuggest("Epic Hazy IPA", 16, "can", sqVars);
    // sv1 scores: +4 (vol 16==16) +3 (epic hazy overlap) +1 (4-pack) = 8
    // sv2 scores: +4 +3 +1 (loose) = 8 — tie; we just check high confidence
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
  });

  it("returns null when volume doesn't match and name tokens don't overlap", () => {
    const result = autoSuggest("Totally Unrelated", 355, "can", sqVars);
    expect(result).toBeNull();
  });

  it("only considers items in the correct category", () => {
    const result = autoSuggest("Epic Hazy IPA", 16, "keg", sqVars);
    // Only keg category: sv3 (Some Other Beer, 1984 fl oz) — name no overlap, volume no match → score 0 → null
    expect(result).toBeNull();
  });

  it("returns medium confidence when score 3–5", () => {
    // Name matches but volume doesn't
    const result = autoSuggest("Epic Hazy IPA", 999, "can", sqVars);
    // sv1: +0 vol + +3 name + +1 = 4 → medium
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("medium");
  });

  it("stop words are ignored in token comparison", () => {
    // "IPA" is a stop word — only "epic" and "hazy" are content tokens
    const vars: SquareCatalogVariationFlat[] = [
      { squareVariationId: "sv5", squareItemId: "si5", itemName: "Epic Hazy", variationName: "Loose", categoryName: "Cans", volumeFlOzPerUnit: 16 },
    ];
    const result = autoSuggest("Epic Hazy IPA", 16, "can", vars);
    expect(result).not.toBeNull(); // should still find overlap on "epic" + "hazy"
  });
});

// ── deriveColumns ─────────────────────────────────────────────────────────────

const makeRpv = (
  recipeId: string,
  variationId: string,
  containerType: "keg" | "can",
  volumeFlOz: number,
  format: string,
  containerName: string,
  isActive = true
): RpvRow => ({
  recipeId,
  variationId,
  containerType,
  volumeFlOz,
  format,
  containerName,
  isActive,
  partnerId: null,
  partnerName: null,
  variationName: variationId,
});

describe("deriveColumns", () => {
  it("produces draft as first column always", () => {
    const cols = deriveColumns([makeRpv("r1", "v1", "can", 16, "loose", "16oz Blank")]);
    expect(cols[0].key).toBe("draft");
    expect(cols[0].type).toBe("draft");
  });

  it("orders kegs before cans, kegs descending volume, cans ascending volume then format order", () => {
    const rpvs = [
      makeRpv("r1", "v1", "can", 12, "loose", "12oz Blank"),
      makeRpv("r1", "v2", "keg", 992, "loose", "¼ Keg"),
      makeRpv("r1", "v3", "keg", 1984, "loose", "½ Keg"),
      makeRpv("r1", "v4", "can", 16, "4-pack", "16oz Blank"),
    ];
    const cols = deriveColumns(rpvs);
    const keys = cols.map((c) => c.key);
    expect(keys[0]).toBe("draft");
    expect(keys[1]).toBe("keg|1984|loose"); // bigger keg first
    expect(keys[2]).toBe("keg|992|loose");
    expect(keys[3]).toBe("can|12|loose");
    expect(keys[4]).toBe("can|16|4-pack");
  });

  it("deduplicates columns (same type+vol+format from multiple recipes)", () => {
    const rpvs = [
      makeRpv("r1", "v1", "can", 16, "loose", "16oz Blank"),
      makeRpv("r2", "v2", "can", 16, "loose", "16oz Blank"),
    ];
    const cols = deriveColumns(rpvs);
    expect(cols.filter((c) => c.key === "can|16|loose").length).toBe(1);
  });

  it("keg label uses container name", () => {
    const rpvs = [makeRpv("r1", "v1", "keg", 1984, "loose", "½ Keg")];
    const cols = deriveColumns(rpvs);
    const kegCol = cols.find((c) => c.type === "keg");
    expect(kegCol?.label).toBe("½ Keg");
  });

  it("can label uses vol+format", () => {
    const rpvs = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
    const cols = deriveColumns(rpvs);
    const canCol = cols.find((c) => c.type === "can");
    expect(canCol?.label).toBe("16oz 4-Pack");
  });
});

// ── buildGrid ─────────────────────────────────────────────────────────────────

describe("buildGrid", () => {
  const rpvs = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
  const recipes = [{ id: "r1", beerName: "Epic Hazy IPA" }];
  const cols = deriveColumns(rpvs);
  const sqVarsSimple: SquareCatalogVariationFlat[] = [
    { squareVariationId: "sv1", squareItemId: "si1", itemName: "Epic Hazy IPA", variationName: "4-Pack", categoryName: "Cans", volumeFlOzPerUnit: 16 },
  ];

  it("returns null cell for draft when recipe has no draft link", () => {
    const rows = buildGrid(recipes, cols, rpvs, [], sqVarsSimple);
    const row = rows[0];
    const draftCell = row.cells["draft"];
    expect(draftCell).not.toBeNull();
    expect(draftCell!.variations.length).toBe(1);
    expect(draftCell!.variations[0].linkedSquareCatalogVariationId).toBeNull();
  });

  it("cell has null when recipe has no variation for a column", () => {
    const rpvsSingle = [makeRpv("r1", "v1", "can", 16, "4-pack", "16oz Blank")];
    const cols2 = deriveColumns([
      ...rpvsSingle,
      makeRpv("r2", "v2", "can", 12, "loose", "12oz Blank"),
    ]);
    const rows = buildGrid(
      [{ id: "r1", beerName: "Epic Hazy IPA" }],
      cols2,
      rpvsSingle,
      [],
      sqVarsSimple
    );
    expect(rows[0].cells["can|12|loose"]).toBeNull();
  });

  it("marks cell variation linked when link exists", () => {
    const links: LinkRow[] = [{
      id: "l1", recipeId: "r1", packaging: "can", variationId: "v1",
      squareCatalogVariationId: "sv1", squareVariationId: "sv1",
      variationName: "4-Pack", itemName: "Epic Hazy IPA",
    }];
    const rows = buildGrid(recipes, cols, rpvs, links, sqVarsSimple);
    const cell = rows[0].cells["can|16|4-pack"]!;
    expect(cell.variations[0].linkedSquareCatalogVariationId).toBe("sv1");
  });
});
