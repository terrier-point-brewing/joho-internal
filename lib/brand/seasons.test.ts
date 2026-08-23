import { describe, expect, it } from "vitest";
import {
  activateSeason,
  addSeasonAsset,
  canActivateSeason,
  canonTokenChoices,
  createSeason,
  getActiveSeason,
  kitByRole,
  kitGapSentence,
  kitGaps,
  listSeasonAssets,
  listSeasonKits,
  listSeasons,
  moveSeasonAsset,
  normalizeSeasonPalette,
  removeSeasonAsset,
  reorderKit,
  resolveSeasonPalette,
  seasonContext,
  seasonGaps,
  setSeasonAssetNote,
  setSeasonAssetRole,
  updateSeason,
  type BrandSeason,
  type BrandSeasonAsset,
  type CanonToken,
  type SeasonAssetClient,
  type SupabaseLikeClient,
} from "./seasons";
import { fakeBrandClient } from "./__fixtures__/fakeBrandClient";

const client = (rows: Partial<BrandSeason>[] = []) =>
  fakeBrandClient(rows as never, { uniqueWhere: { column: "status", value: "active" } });

/**
 * A fake for `brand_season_assets`, which `fakeBrandClient` cannot stand in for:
 * the table has a composite primary key and no `id`, so writes address a row by
 * three columns via `.match()` and an insert has no `.select().single()`.
 *
 * It enforces the primary key, which is the point — re-roling and adding both
 * depend on a duplicate being refused rather than silently landing twice.
 */
function fakeKitClient(initial: Partial<BrandSeasonAsset>[] = []) {
  const rows = initial.map((r) => ({ note: null, position: 0, ...r }) as BrandSeasonAsset);

  const matches = (row: BrandSeasonAsset, criteria: Record<string, string>) =>
    Object.entries(criteria).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);

  function chain(filters: [string, string][]) {
    const filtered = () =>
      rows.filter((r) =>
        filters.every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
      );
    return {
      eq: (column: string, value: string) => chain([...filters, [column, value]]),
      order: (column: string) =>
        Promise.resolve({
          data: [...filtered()].sort(
            (a, b) =>
              Number((a as unknown as Record<string, unknown>)[column]) -
              Number((b as unknown as Record<string, unknown>)[column]),
          ),
          error: null,
        }),
    };
  }

  return {
    rows,
    from() {
      return {
        select: () => chain([]),
        insert: (row: Record<string, unknown>) => {
          const clash = rows.some(
            (r) =>
              r.season_id === row.season_id &&
              r.asset_id === row.asset_id &&
              r.role === row.role,
          );
          if (clash) return Promise.resolve({ error: { message: "duplicate key" } });
          rows.push(row as unknown as BrandSeasonAsset);
          return Promise.resolve({ error: null });
        },
        update: (patch: Record<string, unknown>) => ({
          match: (criteria: Record<string, string>) => {
            for (const row of rows.filter((r) => matches(r, criteria))) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        }),
        delete: () => ({
          match: (criteria: Record<string, string>) => {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (matches(rows[i], criteria)) rows.splice(i, 1);
            }
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

const kitClient = (rows: Partial<BrandSeasonAsset>[] = []) =>
  fakeKitClient(rows) as unknown as SeasonAssetClient & { rows: BrandSeasonAsset[] };

const TOKENS: CanonToken[] = [
  { key: "indigo", name: "Indigo", hex: "#26355d", tier: "core" },
  { key: "seal-red", name: "Seal Red", hex: "#ad1a2d", tier: "core" },
  { key: "chalk", name: "Chalk", hex: "#afb7ca", tier: "neutral" },
];

describe("seasonContext", () => {
  it("maps a season onto exactly what a motif slot can resolve", () => {
    expect(
      seasonContext({
        id: "s1", name: "S1", background_hex: "#26355d", chop_glyph_asset_id: "a1",
        season_logo_asset_id: "a2", cultural_lean: null, motif_set: [],
        palette: { ink: "indigo" }, voice_note: null,
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

// ─── The palette: a season selects from the canon and never redefines it ─────

describe("canonTokenChoices", () => {
  it("offers the canon's palette, core colors first", () => {
    expect(
      canonTokenChoices({
        palette: [
          { key: "chalk", name: "Chalk", hex: "#afb7ca", tier: "neutral" },
          { key: "indigo", name: "Indigo", hex: "#26355d", tier: "core" },
        ],
      }).map((t) => t.key),
    ).toEqual(["indigo", "chalk"]);
  });
});

describe("resolveSeasonPalette", () => {
  it("resolves a stored key to the canon's current color", () => {
    expect(resolveSeasonPalette({ ink: "indigo" }, TOKENS)[0]).toEqual({
      role: "ink",
      state: "resolved",
      token: "indigo",
      name: "Indigo",
      hex: "#26355d",
    });
  });

  it("reports an unset role rather than inventing one", () => {
    expect(resolveSeasonPalette({}, TOKENS).map((r) => r.state)).toEqual(["unset", "unset"]);
  });

  // The case the whole token indirection is for: a season stores a KEY, so a
  // canon edit that drops a color leaves the season pointing at nothing.
  // Rendering nothing would hide it; the board has to be able to say so.
  it("marks a role pointing at a token the canon no longer declares", () => {
    expect(resolveSeasonPalette({ accent: "sunset-orange" }, TOKENS)[1]).toEqual({
      role: "accent",
      state: "unknown",
      token: "sunset-orange",
    });
  });

  // A canon RENAME is the same failure with a friendlier cause, and it must not
  // silently resolve to whatever now sits at that position.
  it("does not fall back to another color when a key is renamed away", () => {
    const renamed: CanonToken[] = [{ key: "indigo-deep", name: "Indigo", hex: "#26355d" }];
    expect(resolveSeasonPalette({ ink: "indigo" }, renamed)[0]).toMatchObject({
      state: "unknown",
      token: "indigo",
    });
  });
});

describe("normalizeSeasonPalette", () => {
  it("accepts a key the canon declares", () => {
    expect(normalizeSeasonPalette({ ink: "indigo", accent: "seal-red" }, TOKENS)).toEqual({
      ink: "indigo",
      accent: "seal-red",
    });
  });

  // The single rule this module exists to keep: a season may not invent a brand
  // color, so a hex is refused however it is spelled.
  it("refuses a raw hex, naming the canon as the place to change", () => {
    expect(() => normalizeSeasonPalette({ ink: "#ff0000" }, TOKENS)).toThrow(/change the canon/);
  });

  it("refuses a key the canon does not declare", () => {
    expect(() => normalizeSeasonPalette({ accent: "sunset-orange" }, TOKENS)).toThrow(
      /must name a color the canon declares/,
    );
  });

  it("refuses a role outside the two the CHECK allows — the ground has its own field", () => {
    expect(() => normalizeSeasonPalette({ ground: "indigo" }, TOKENS)).toThrow(
      /not a season palette role/,
    );
  });

  it("clears a role rather than storing an empty string", () => {
    expect(normalizeSeasonPalette({ ink: "", accent: null }, TOKENS)).toEqual({});
  });

  it("refuses anything that is not an object", () => {
    expect(() => normalizeSeasonPalette(["indigo"], TOKENS)).toThrow(/must be an object/);
  });
});

// ─── The kit ────────────────────────────────────────────────────────────────

const furnished = {
  background_hex: "#26355d",
  chop_glyph_asset_id: "a1",
  voice_note: "Warmer, slower, less certain.",
};

describe("kitGaps", () => {
  // The acceptance case: "Season 1" has been active with every field empty for
  // as long as it has existed, and nothing anywhere said so.
  it("names every missing piece of an empty season", () => {
    expect(
      kitGaps({ background_hex: null, chop_glyph_asset_id: null, voice_note: null }, []),
    ).toEqual(["a ground color", "a chop glyph", "a motif", "an example", "a voice note"]);
  });

  it("is empty for a furnished season", () => {
    expect(kitGaps(furnished, [{ role: "motif" }, { role: "example" }])).toEqual([]);
  });

  // A texture is not part of a complete kit, and a season full of them is still
  // missing its motifs.
  it("does not count a texture as a motif or an example", () => {
    expect(kitGaps(furnished, [{ role: "texture" }])).toEqual(["a motif", "an example"]);
  });

  it("treats a whitespace-only voice note as absent", () => {
    expect(
      kitGaps({ ...furnished, voice_note: "   " }, [{ role: "motif" }, { role: "example" }]),
    ).toEqual(["a voice note"]);
  });
});

describe("kitGapSentence", () => {
  it("says what is missing in one sentence", () => {
    expect(kitGapSentence("Season 1", ["a ground color", "a chop glyph", "a motif"])).toBe(
      "Season 1 is not furnished yet — it still needs a ground color, a chop glyph and a motif.",
    );
  });

  it("is null for a complete kit, so a finished season says nothing", () => {
    expect(kitGapSentence("Season 2", [])).toBeNull();
  });
});

describe("reorderKit", () => {
  const group = (positions: number[]) =>
    positions.map((position, i) => ({
      season_id: "s1",
      asset_id: `a${i}`,
      role: "motif" as const,
      position,
      note: null,
    }));

  it("moves an item one place and renumbers densely", () => {
    expect(reorderKit(group([0, 1, 2]), "a2", "up")).toEqual([
      { asset_id: "a2", position: 1 },
      { asset_id: "a1", position: 2 },
    ]);
  });

  // `position` carries no unique constraint deliberately, so a group can pick up
  // duplicates. A swap would reorder into something nobody asked for; a dense
  // renumber repairs the group on the way past.
  it("repairs duplicate positions rather than swapping through them", () => {
    // a1 keeps 0, so it is not written; a0 and a2 take the positions that make
    // the group [a1, a0, a2] rather than three rows all claiming index 0.
    expect(reorderKit(group([0, 0, 0]), "a0", "down")).toEqual([
      { asset_id: "a0", position: 1 },
      { asset_id: "a2", position: 2 },
    ]);
  });

  it("writes nothing at either end of the list", () => {
    expect(reorderKit(group([0, 1, 2]), "a0", "up")).toEqual([]);
    expect(reorderKit(group([0, 1, 2]), "a2", "down")).toEqual([]);
  });

  it("writes nothing for an asset that is not in the group", () => {
    expect(reorderKit(group([0, 1]), "nope", "up")).toEqual([]);
  });
});

describe("season assets", () => {
  it("appends to the end of its own role group", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0 },
      { season_id: "s1", asset_id: "a2", role: "motif", position: 1 },
      { season_id: "s1", asset_id: "a3", role: "example", position: 0 },
    ]);
    await addSeasonAsset(c, { season_id: "s1", asset_id: "a4", role: "motif" });
    expect(c.rows.find((r) => r.asset_id === "a4")!.position).toBe(2);
  });

  it("starts a fresh role group at zero", async () => {
    const c = kitClient();
    await addSeasonAsset(c, { season_id: "s1", asset_id: "a1", role: "example" });
    expect(c.rows[0].position).toBe(0);
  });

  it("stores an empty note as absent", async () => {
    const c = kitClient();
    await addSeasonAsset(c, { season_id: "s1", asset_id: "a1", role: "motif", note: "  " });
    expect(c.rows[0].note).toBeNull();
  });

  // The same file can be a texture AND a motif — one file, two jobs — which is
  // why `role` is in the primary key.
  it("lets one asset hold two roles in the same season", async () => {
    const c = kitClient([{ season_id: "s1", asset_id: "a1", role: "motif", position: 0 }]);
    await addSeasonAsset(c, { season_id: "s1", asset_id: "a1", role: "texture" });
    expect(c.rows).toHaveLength(2);
  });

  it("refuses the same asset in the same role twice", async () => {
    const c = kitClient([{ season_id: "s1", asset_id: "a1", role: "motif", position: 0 }]);
    await expect(
      addSeasonAsset(c, { season_id: "s1", asset_id: "a1", role: "motif" }),
    ).rejects.toThrow(/already holds that role/);
  });

  it("removes only the row with that exact role", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0 },
      { season_id: "s1", asset_id: "a1", role: "texture", position: 0 },
    ]);
    await removeSeasonAsset(c, { season_id: "s1", asset_id: "a1", role: "motif" });
    expect(c.rows.map((r) => r.role)).toEqual(["texture"]);
  });

  it("saves a note, and clears it when blanked", async () => {
    const key = { season_id: "s1", asset_id: "a1", role: "motif" as const };
    const c = kitClient([{ ...key, position: 0 }]);
    await setSeasonAssetNote(c, key, "  the wave  ");
    expect(c.rows[0].note).toBe("the wave");
    await setSeasonAssetNote(c, key, "");
    expect(c.rows[0].note).toBeNull();
  });

  it("moves an item and leaves the group densely ordered", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0 },
      { season_id: "s1", asset_id: "a2", role: "motif", position: 1 },
      { season_id: "s1", asset_id: "a3", role: "motif", position: 2 },
    ]);
    await moveSeasonAsset(c, { season_id: "s1", asset_id: "a3", role: "motif" }, "up");
    expect(kitByRole(await listSeasonAssets(c, "s1"), "motif").map((r) => r.asset_id)).toEqual([
      "a1",
      "a3",
      "a2",
    ]);
  });

  it("re-roles a row to the end of its new group, keeping the note", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0, note: "the wave" },
      { season_id: "s1", asset_id: "a2", role: "example", position: 0 },
    ]);
    await setSeasonAssetRole(c, { season_id: "s1", asset_id: "a1", role: "motif" }, "example");

    expect(c.rows.filter((r) => r.role === "motif")).toHaveLength(0);
    expect(c.rows.find((r) => r.asset_id === "a1")).toMatchObject({
      role: "example",
      position: 1,
      note: "the wave",
    });
  });

  // Insert-then-delete: if the asset already holds the target role the insert
  // fails and the original row survives, which is the safer of the two failures.
  it("keeps the original row when the target role is already held", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0 },
      { season_id: "s1", asset_id: "a1", role: "texture", position: 0 },
    ]);
    await expect(
      setSeasonAssetRole(c, { season_id: "s1", asset_id: "a1", role: "motif" }, "texture"),
    ).rejects.toThrow();
    expect(c.rows.filter((r) => r.role === "motif")).toHaveLength(1);
  });

  it("groups every season's kit in one read", async () => {
    const c = kitClient([
      { season_id: "s1", asset_id: "a1", role: "motif", position: 0 },
      { season_id: "s2", asset_id: "a2", role: "motif", position: 0 },
      { season_id: "s1", asset_id: "a3", role: "example", position: 0 },
    ]);
    const kits = await listSeasonKits(c);
    expect(kits.get("s1")).toHaveLength(2);
    expect(kits.get("s2")).toHaveLength(1);
    expect(kits.get("s3")).toBeUndefined();
  });
});

describe("createSeason writes", () => {
  // `motif_set` is legacy from the season-kit board onward: motifs are rows in
  // brand_season_assets, and the column defaults to '[]' on its own.
  it("never writes motif_set", async () => {
    const c = client();
    await createSeason(c as unknown as SupabaseLikeClient, { name: "Season 2" });
    expect(c.rows[0]).not.toHaveProperty("motif_set");
  });
});
