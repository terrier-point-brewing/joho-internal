import { describe, expect, it } from "vitest";
import {
  activateSeason,
  createSeason,
  getActiveSeason,
  listSeasons,
  seasonContext,
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

describe("activateSeason", () => {
  // Activating is the moment every motif slot in the system changes what it
  // resolves to, so it must be one deliberate swap with exactly one winner.
  it("archives the outgoing season before activating the new one", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active" },
      { id: "s2", name: "Season 2", status: "draft" },
    ]);

    await activateSeason(c as unknown as SupabaseLikeClient, "s2");

    expect(c.rows.find((r) => r.id === "s1")!.status).toBe("archived");
    expect(c.rows.find((r) => r.id === "s2")!.status).toBe("active");
  });

  // The fake enforces the partial unique index, so an activate-then-archive
  // ordering fails here instead of quietly leaving two active seasons.
  it("never leaves two seasons active", async () => {
    const c = client([
      { id: "s1", name: "Season 1", status: "active" },
      { id: "s2", name: "Season 2", status: "draft" },
    ]);
    await activateSeason(c as unknown as SupabaseLikeClient, "s2");
    expect(c.rows.filter((r) => r.status === "active")).toHaveLength(1);
  });

  it("is a no-op-safe re-activation of the season already in force", async () => {
    const c = client([{ id: "s1", name: "Season 1", status: "active" }]);
    await activateSeason(c as unknown as SupabaseLikeClient, "s1");
    expect(c.rows.filter((r) => r.status === "active")).toHaveLength(1);
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
