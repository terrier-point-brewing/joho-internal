import { describe, expect, it } from "vitest";
import {
  approveOutput,
  collectAssetRefs,
  createOutput,
  listOutputs,
  markExported,
  snapshotTokens,
  type BrandOutput,
  type SupabaseLikeClient,
} from "./outputs";
import { fakeBrandClient } from "./__fixtures__/fakeBrandClient";
import type { BrandCanon } from "./canon.types";
import type { BrandSeason } from "./seasons";
import type { Slot } from "./slots";

const client = (rows: Partial<BrandOutput>[] = []) => fakeBrandClient(rows as never);

const base = {
  template_id: "t1", template_version: 1, rendition: "front",
  inputs: {}, tokens_snapshot: {}, asset_refs: [],
};

describe("snapshotTokens", () => {
  const canon = {
    palette: [
      { key: "indigo", name: "Indigo", hex: "#26355d" },
      { key: "paper", name: "Paper", hex: "#f5f0e6" },
    ],
    roleMap: { light: { primary: "indigo", canvas: "paper" }, dark: { primary: "paper" } },
  } as unknown as BrandCanon;

  // The resolved VALUES, not the roleMap. A roleMap is pointers into a palette
  // that can move underneath it — storing it would record which token was used
  // without recording what it was.
  it("resolves roles to the hex values actually used", () => {
    expect(snapshotTokens(canon)).toEqual({ primary: "#26355d", canvas: "#f5f0e6" });
  });

  it("snapshots the dark set when asked", () => {
    expect(snapshotTokens(canon, "dark")).toEqual({ primary: "#f5f0e6" });
  });

  it("drops a role bound to a palette key that no longer exists", () => {
    const broken = {
      ...canon, roleMap: { light: { primary: "indigo", accent: "gone" }, dark: {} },
    } as unknown as BrandCanon;
    expect(snapshotTokens(broken)).toEqual({ primary: "#26355d" });
  });

  it("survives a canon with no palette or roleMap", () => {
    expect(snapshotTokens({} as BrandCanon)).toEqual({});
  });
});

describe("collectAssetRefs", () => {
  const slots: Slot[] = [
    { type: "asset", key: "art", label: "Art", required: true, kind: "label_art" },
    { type: "motif", key: "chop", label: "Chop", required: true, resolves: "chop-glyph" },
    { type: "motif", key: "ground", label: "Ground", required: true, resolves: "background" },
    { type: "text", key: "name", label: "Name", required: true, fontRole: "display", fit: "shrink" },
  ];
  const season = {
    chop_glyph_asset_id: "glyph-1", season_logo_asset_id: "logo-1",
  } as unknown as BrandSeason;

  // This is what makes the decision NOT to version assets sufficient: an output
  // names the immutable rows it drew from, so a newer approved asset of the same
  // kind never retroactively changes what shipped.
  it("pins the exact asset ids from both author input and the season", () => {
    expect(collectAssetRefs({ slots }, { art: "art-9", name: "X" }, season)).toEqual([
      { slot: "art", assetId: "art-9" },
      { slot: "chop", assetId: "glyph-1" },
    ]);
  });

  it("records nothing for a background motif — it is a color, not an asset", () => {
    const refs = collectAssetRefs({ slots }, {}, season);
    expect(refs.find((r) => r.slot === "ground")).toBeUndefined();
  });

  it("omits motif refs when no season was in force", () => {
    expect(collectAssetRefs({ slots }, { art: "art-9" }, null)).toEqual([
      { slot: "art", assetId: "art-9" },
    ]);
  });

  it("ignores an empty asset input rather than pinning a blank id", () => {
    expect(collectAssetRefs({ slots }, { art: "" }, null)).toEqual([]);
  });
});

describe("createOutput", () => {
  // An insert that could land pre-approved is one refactor away from an agent
  // doing the same, so the status is not caller-supplied at all.
  it("always lands as a draft, even for a human", async () => {
    const c = client();
    const out = await createOutput(c as unknown as SupabaseLikeClient, { ...base, source: "human" });
    expect(out.status).toBe("draft");
  });

  it("records an agent draft as agent-sourced", async () => {
    const c = client();
    const out = await createOutput(c as unknown as SupabaseLikeClient, { ...base, source: "agent" });
    expect(out.status).toBe("draft");
    expect(out.source).toBe("agent");
  });

  it("defaults an unspecified source to human", async () => {
    const c = client();
    expect((await createOutput(c as unknown as SupabaseLikeClient, base)).source).toBe("human");
  });
});

describe("the review gate", () => {
  it("refuses to export a draft", async () => {
    const c = client([{ id: "o1", status: "draft" }]);
    await expect(
      markExported(c as unknown as SupabaseLikeClient, "o1", "output/o1/front.pdf"),
    ).rejects.toThrow(/approve it first/);
    expect(c.rows[0].status).toBe("draft");
    expect(c.rows[0].rendered_path).toBeUndefined();
  });

  it("exports an approved output and records where it landed", async () => {
    const c = client([{ id: "o1", status: "draft" }]);
    await approveOutput(c as unknown as SupabaseLikeClient, "o1");
    await markExported(c as unknown as SupabaseLikeClient, "o1", "output/o1/front.pdf");

    expect(c.rows[0].status).toBe("exported");
    expect(c.rows[0].rendered_path).toBe("output/o1/front.pdf");
    expect(c.rows[0].exported_at).toBeTruthy();
  });

  it("refuses to re-export an already exported output", async () => {
    const c = client([{ id: "o1", status: "exported" }]);
    await expect(
      markExported(c as unknown as SupabaseLikeClient, "o1", "output/o1/again.pdf"),
    ).rejects.toThrow();
  });

  it("throws on a missing output", async () => {
    await expect(
      markExported(client() as unknown as SupabaseLikeClient, "nope", "x"),
    ).rejects.toThrow(/not found/);
  });
});

describe("listOutputs", () => {
  const rows: Partial<BrandOutput>[] = [
    { id: "o1", label_id: "l1", template_id: "t1", status: "draft" },
    { id: "o2", label_id: "l1", template_id: "t2", status: "approved" },
    { id: "o3", label_id: "l2", template_id: "t1", status: "draft" },
  ];

  it("filters by label, template and status", async () => {
    const c = client(rows) as unknown as SupabaseLikeClient;
    expect(await listOutputs(c, { labelId: "l1" })).toHaveLength(2);
    expect(await listOutputs(c, { templateId: "t1" })).toHaveLength(2);
    expect(await listOutputs(c, { status: "approved" })).toHaveLength(1);
    expect(await listOutputs(c)).toHaveLength(3);
  });
});
