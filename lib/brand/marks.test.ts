import { describe, expect, it } from "vitest";
import { groupChopsBySeason, groupVariations, pickDisplayAsset } from "./marks";
import type { BrandAsset } from "./assets";
import type { BrandSeason } from "./seasons";

const asset = (over: Partial<BrandAsset> & { id: string }): BrandAsset => ({
  kind: "wordmark",
  variant: "default",
  storage_path: `wordmark/${over.id}.svg`,
  format: "svg",
  file_meta: {},
  status: "approved",
  ...over,
});

const season = (over: Partial<BrandSeason> & { id: string; name: string }): BrandSeason => ({
  background_hex: null,
  chop_glyph_asset_id: null,
  cultural_lean: null,
  motif_set: [],
  season_logo_asset_id: null,
  palette: {},
  voice_note: null,
  starts_at: null,
  ends_at: null,
  status: "active",
  activation_override_reason: null,
  ...over,
});

describe("pickDisplayAsset", () => {
  it("prefers the vector, whatever order the files arrive in", () => {
    const files = [asset({ id: "png", format: "png" }), asset({ id: "svg", format: "svg" })];
    expect(pickDisplayAsset(files)?.id).toBe("svg");
  });

  it("falls back to a raster when there is no vector", () => {
    expect(pickDisplayAsset([asset({ id: "png", format: "png" })])?.id).toBe("png");
  });

  it("returns null when nothing is displayable — a PDF is a download, not a view", () => {
    expect(pickDisplayAsset([asset({ id: "pdf", format: "pdf" })])).toBeNull();
  });
});

describe("groupVariations", () => {
  it("puts the SVG and PNG of one variation on one card", () => {
    const cards = groupVariations([
      asset({ id: "a", variant: "square-paper", format: "svg" }),
      asset({ id: "b", variant: "square-paper", format: "png" }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].files.map((f) => f.format)).toEqual(["svg", "png"]);
    expect(cards[0].display?.id).toBe("a");
  });

  it("keeps different variants as different cards", () => {
    const cards = groupVariations([
      asset({ id: "a", variant: "square-paper" }),
      asset({ id: "b", variant: "wide-indigo" }),
    ]);
    expect(cards.map((c) => c.key)).toEqual(["square-paper", "wide-indigo"]);
  });

  it("reads a facet typed on the PNG when the SVG left it blank", () => {
    const cards = groupVariations([
      asset({ id: "a", variant: "v", format: "svg" }),
      asset({ id: "b", variant: "v", format: "png", description: "Use on dark ground" }),
    ]);
    expect(cards[0].description).toBe("Use on dark ground");
  });

  it("carries the orientation facet through, same as shape/ink/ground", () => {
    const cards = groupVariations([
      asset({ id: "a", variant: "v", orientation: "vertical" }),
    ]);
    expect(cards[0].orientation).toBe("vertical");
  });

  it("names the card by its title, falling back to the variant slug", () => {
    const cards = groupVariations([
      asset({ id: "a", variant: "square-paper", title: "Square · Paper" }),
      asset({ id: "b", variant: "wide-indigo" }),
    ]);
    expect(cards.map((c) => c.label)).toEqual(["Square · Paper", "wide-indigo"]);
  });

  it("does not reshuffle when a second format joins an existing variation", () => {
    const before = groupVariations([
      asset({ id: "a", variant: "first" }),
      asset({ id: "b", variant: "second" }),
    ]);
    const after = groupVariations([
      asset({ id: "a", variant: "first" }),
      asset({ id: "b", variant: "second" }),
      asset({ id: "c", variant: "first", format: "png" }),
    ]);
    expect(after.map((c) => c.key)).toEqual(before.map((c) => c.key));
  });
});

describe("groupChopsBySeason", () => {
  const chop = (over: Partial<BrandAsset> & { id: string }) =>
    asset({ kind: "chop_glyph", ...over });

  it("leads with the generic set, then the seasons in the order given", () => {
    const groups = groupChopsBySeason(
      [
        chop({ id: "g", season_id: null }),
        chop({ id: "s1", season_id: "one" }),
        chop({ id: "s2", season_id: "two" }),
      ],
      [season({ id: "one", name: "Season One" }), season({ id: "two", name: "Season Two" })],
    );
    expect(groups.map((g) => g.seasonName)).toEqual(["Generic", "Season One", "Season Two"]);
    expect(groups[0].generic).toBe(true);
  });

  it("keeps several chops under one season", () => {
    const groups = groupChopsBySeason(
      [
        chop({ id: "a", variant: "a", season_id: "one" }),
        chop({ id: "b", variant: "b", season_id: "one" }),
      ],
      [season({ id: "one", name: "Season One" })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].chops.map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("puts the SVG and PNG of one chop on one card, as a wordmark does", () => {
    const groups = groupChopsBySeason(
      [
        chop({ id: "a", variant: "autumn", format: "svg", season_id: "one" }),
        chop({ id: "b", variant: "autumn", format: "png", season_id: "one" }),
      ],
      [season({ id: "one", name: "Season One" })],
    );
    expect(groups[0].chops).toHaveLength(1);
    expect(groups[0].chops[0].files.map((f) => f.format)).toEqual(["svg", "png"]);
  });

  it("omits a season that has no chops rather than showing an empty heading", () => {
    const groups = groupChopsBySeason(
      [chop({ id: "a", season_id: "one" })],
      [season({ id: "one", name: "Season One" }), season({ id: "two", name: "Season Two" })],
    );
    expect(groups.map((g) => g.seasonName)).toEqual(["Season One"]);
  });

  it("omits the generic group entirely when nothing is seasonless", () => {
    const groups = groupChopsBySeason(
      [chop({ id: "a", season_id: "one" })],
      [season({ id: "one", name: "Season One" })],
    );
    expect(groups.some((g) => g.generic)).toBe(false);
  });

  it("surfaces a chop pointing at a deleted season instead of dropping it", () => {
    const groups = groupChopsBySeason([chop({ id: "orphan", season_id: "gone" })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].generic).toBe(true);
    expect(groups[0].chops.map((c) => c.key)).toEqual(["default"]);
  });

  it("carries the season's designated chop through as the primary", () => {
    const groups = groupChopsBySeason(
      [
        chop({ id: "a", variant: "a", season_id: "one" }),
        chop({ id: "b", variant: "b", season_id: "one" }),
      ],
      [season({ id: "one", name: "Season One", chop_glyph_asset_id: "b" })],
    );
    expect(groups[0].primaryAssetId).toBe("b");
  });
});
