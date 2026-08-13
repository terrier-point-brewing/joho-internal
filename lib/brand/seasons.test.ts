import { describe, expect, it } from "vitest";
import {
  activateSeason,
  canActivateSeason,
  createSeason,
  getActiveSeason,
  listSeasons,
  seasonContext,
  seasonGaps,
  updateSeason,
  type BrandSeason,
  type SupabaseLikeClient,
} from "./seasons";
import { fakeBrandClient } from "./__fixtures__/fakeBrandClient";

const client = (rows: Partial<BrandSeason>[] = []) =>
  fakeBrandClient(rows as never, { uniqueWhere: { column: "status", value: "active" } });

describe("seasonContext", () => {
  it("maps a season onto exactly what a motif slot can resolve", () => {
    expect(
      seasonContext({
        id: "s1", name: "S1", background_hex: "#26355d", chop_glyph_asset_id: "a1",
        season_logo_asset_id: "a2", cultural_lean: null, motif_set: [],
        starts_at: null, ends_at: null, status: "active",
      }),
    ).toEqual({ backgroundHex: "#26355d", chopGlyphAssetId: "a1", seasonLogoAssetId: "a2" });
  });

  it("returns null for no season, which is what the validator checks", () => {
    expect(seasonContext(null)).toBeNull();
  });
});

describe("createSeason", () => {
  it("starts as a draft, never active", async () => {
    const c = client();
    const s = await createSeason(c as unknown as SupabaseLikeClient, {
      name: "Season 1", background_hex: "#26355d",
    });
    expect(s.status).toBe("draft");
  });
});

describe("seasonGaps", () => {
  // The chop glyph is the one thing a motif slot cannot fall back on: the canon
  // fixes everything about the chop except which glyph it draws.
  it("blocks on a missing chop glyph", () => {
    expect(seasonGaps({ chop_glyph_asset_id: null, background_hex: "#26355d" })).toEqual({
      blocking: ["a chop glyph"],
      warnings: [],
    });
  });

  // A template can simply not declare a background motif slot — menu and
  // apparel templates don't — so this is a gap, not a blocker.
  it("only warns on a missing background", () => {
    expect(seasonGaps({ chop_glyph_asset_id: "a1", background_hex: null })).toEqual({
      blocking: [],
      warnings: ["background color"],
    });
  });

  it("canActivateSeason follows the blocking list, not the warnings", () => {
    expect(canActivateSeason({ chop_glyph_asset_id: "a1", background_hex: null })).toBe(true);
    expect(canActivateSeason({ chop_glyph_asset_id: null, background_hex: "#26355d" })).toBe(false);
  });
});

describe("updateSeason", () => {
  // activateSeason is gated; a field patch that could set status would be a way
  // straight around that gate, and the PATCH route forwards an arbitrary body.
  it("ignores a status in the patch", async () => {
    const c = client([{ id: "s1", name: "Season 1", status: "draft" }]);
    await updateSeason(c as unknown as SupabaseLikeClient, "s1", {
      status: "active",
      background_hex: "#26355d",
    } as never);
    expect(c.rows.find((r) => r.id === "s1")!.status).toBe("draft");
    expect(c.rows.find((r) => r.id === "s1")!.background_hex).toBe("#26355d");
  });
});

describe("activateSeason", () => {
  // Activating is the moment every motif slot in the system changes what it
  // resolves to, so it must be one deliberate swap with exactly one winner.
  it("archives the outgoing season before activating the new one", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active", chop_glyph_asset_id: "a1" },
      { id: "s2", name: "Season 2", status: "draft", chop_glyph_asset_id: "a2" },
    ]);

    await activateSeason(c as unknown as SupabaseLikeClient, "s2");

    expect(c.rows.find((r) => r.id === "s1")!.status).toBe("archived");
    expect(c.rows.find((r) => r.id === "s2")!.status).toBe("active");
  });

  // The fake enforces the partial unique index, so an activate-then-archive
  // ordering fails here instead of quietly leaving two active seasons.
  it("never leaves two seasons active", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active", chop_glyph_asset_id: "a1" },
      { id: "s2", name: "Season 2", status: "draft", chop_glyph_asset_id: "a2" },
    ]);
    await activateSeason(c as unknown as SupabaseLikeClient, "s2");
    expect(c.rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("is a no-op-safe re-activation of the season already in force", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active", chop_glyph_asset_id: "a1" },
    ]);
    await activateSeason(c as unknown as SupabaseLikeClient, "s1");
    expect(c.rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("refuses a season with no chop glyph, naming what it needs", async () => {
    const c = client([{ id: "s2", name: "Season 2", status: "draft" }]);
    await expect(
      activateSeason(c as unknown as SupabaseLikeClient, "s2"),
    ).rejects.toThrow(/chop glyph/);
  });

  // The refusal has to come before the archive, or a rejected activation takes
  // the working season down with it.
  it("leaves the outgoing season in force when it refuses", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active", chop_glyph_asset_id: "a1" },
      { id: "s2", name: "Season 2", status: "draft" },
    ]);
    await expect(activateSeason(c as unknown as SupabaseLikeClient, "s2")).rejects.toThrow();
    expect(c.rows.find((r) => r.id === "s1")!.status).toBe("active");
  });

  it("activates without a background, which is only a warning", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "draft", chop_glyph_asset_id: "a1" },
    ]);
    await activateSeason(c as unknown as SupabaseLikeClient, "s1");
    expect(c.rows.find((r) => r.id === "s1")!.status).toBe("active");
  });

  it("throws on a missing season", async () => {
    await expect(activateSeason(client() as unknown as SupabaseLikeClient, "nope")).rejects.toThrow();
  });
});

describe("getActiveSeason", () => {
  it("returns the one in force", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "archived" },
      { id: "s2", name: "Season 2", status: "active" },
    ]);
    expect((await getActiveSeason(c as unknown as SupabaseLikeClient))?.id).toBe("s2");
  });

  it("returns null when none is active, so motif slots fail loudly", async () => {
    const c = client([{ id: "s1", name: "Season 1", status: "draft" }]);
    expect(await getActiveSeason(c as unknown as SupabaseLikeClient)).toBeNull();
  });

  it("listSeasons returns every season regardless of status", async () => {
    const c = client([
      { id: "s1", status: "archived", starts_at: "2026-01-01" },
      { id: "s2", status: "active", starts_at: "2026-06-01" },
    ]);
    expect(await listSeasons(c as unknown as SupabaseLikeClient)).toHaveLength(2);
  });
});
