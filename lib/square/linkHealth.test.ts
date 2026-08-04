import { describe, it, expect } from "vitest";
import { selectDeadLinks, findDeadLinks, type LinkRow } from "./linkHealth";

function link(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: "L1",
    recipe_id: "R1",
    packaging: "can",
    item_name: "Epic Hazy IPA (Cans)",
    variation_name: "Regular",
    square_variation_id: "SQ-LIVE",
    ...over,
  };
}

describe("selectDeadLinks", () => {
  it("passes a link whose variation is live", () => {
    const dead = selectDeadLinks([link()], new Set(["SQ-LIVE"]), new Set(["SQ-LIVE"]));
    expect(dead).toEqual([]);
  });

  it("flags a variation the mirror knows and has marked deleted", () => {
    const dead = selectDeadLinks(
      [link({ square_variation_id: "SQ-GONE" })],
      new Set(["SQ-LIVE"]),
      new Set(["SQ-LIVE", "SQ-GONE"]),
    );
    expect(dead).toEqual([
      expect.objectContaining({ squareVariationId: "SQ-GONE", reason: "deleted_in_square" }),
    ]);
  });

  // Distinguished from the above because the fix differs: this one may just mean
  // the catalog sync has not run since the mapping was made.
  it("flags a variation the mirror has never seen, with a different reason", () => {
    const dead = selectDeadLinks(
      [link({ square_variation_id: "SQ-UNKNOWN" })],
      new Set(["SQ-LIVE"]),
      new Set(["SQ-LIVE"]),
    );
    expect(dead).toEqual([
      expect.objectContaining({ squareVariationId: "SQ-UNKNOWN", reason: "missing_from_catalog" }),
    ]);
  });

  it("carries enough context to re-map without another lookup", () => {
    const [d] = selectDeadLinks(
      [link({ id: "L9", recipe_id: "R9", packaging: "keg", item_name: "Spring Bock (Keg)", variation_name: "1/2 Keg", square_variation_id: "SQ-X" })],
      new Set(),
      new Set(),
    );
    expect(d).toEqual({
      linkId: "L9",
      recipeId: "R9",
      packaging: "keg",
      itemName: "Spring Bock (Keg)",
      variationName: "1/2 Keg",
      squareVariationId: "SQ-X",
      reason: "missing_from_catalog",
    });
  });

  it("returns every dead link, not just the first", () => {
    const dead = selectDeadLinks(
      [
        link({ id: "A", square_variation_id: "SQ-LIVE" }),
        link({ id: "B", square_variation_id: "SQ-GONE-1" }),
        link({ id: "C", square_variation_id: "SQ-GONE-2" }),
      ],
      new Set(["SQ-LIVE"]),
      new Set(["SQ-LIVE", "SQ-GONE-1"]),
    );
    expect(dead.map((d) => [d.linkId, d.reason])).toEqual([
      ["B", "deleted_in_square"],
      ["C", "missing_from_catalog"],
    ]);
  });
});

describe("findDeadLinks", () => {
  function db(links: LinkRow[], vars: { square_variation_id: string; is_deleted: boolean | null }[]) {
    return {
      from: (t: string) => ({
        select: () =>
          t === "recipe_square_links"
            ? { data: links, error: null }
            : { data: vars, error: null },
      }),
    };
  }

  it("treats a null is_deleted as live", () => {
    const out = findDeadLinks(db([link()], [{ square_variation_id: "SQ-LIVE", is_deleted: null }]));
    return expect(out).resolves.toEqual([]);
  });

  it("resolves the two dead reasons off one mirror read", async () => {
    const out = await findDeadLinks(
      db(
        [
          link({ id: "A", square_variation_id: "SQ-LIVE" }),
          link({ id: "B", square_variation_id: "SQ-DEAD" }),
          link({ id: "C", square_variation_id: "SQ-NEVER" }),
        ],
        [
          { square_variation_id: "SQ-LIVE", is_deleted: false },
          { square_variation_id: "SQ-DEAD", is_deleted: true },
        ],
      ),
    );
    expect(out.map((d) => [d.linkId, d.reason])).toEqual([
      ["B", "deleted_in_square"],
      ["C", "missing_from_catalog"],
    ]);
  });

  it("surfaces a query failure rather than reporting every link healthy", async () => {
    const failing = {
      from: () => ({ select: () => ({ data: null, error: { message: "boom" } }) }),
    };
    await expect(findDeadLinks(failing)).rejects.toThrow("boom");
  });
});
