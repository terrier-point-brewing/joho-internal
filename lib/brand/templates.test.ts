import { describe, expect, it } from "vitest";
import {
  createTemplate,
  draftNextVersion,
  getPublishedTemplate,
  getTemplateVersion,
  listTemplates,
  publishTemplate,
  updateTemplate,
  validateTemplateShape,
  type BrandTemplate,
  type SupabaseLikeClient,
} from "./templates";
import { fakeBrandClient } from "./__fixtures__/fakeBrandClient";
import type { Slot } from "./slots";

const textSlot = (key: string): Slot => ({
  type: "text", key, label: key, required: true, fontRole: "display", fit: "shrink",
});

const client = (rows: Partial<BrandTemplate>[] = []) =>
  fakeBrandClient(rows as never, {
    uniqueWhere: { column: "status", value: "published", scopeBy: "key" },
  });

describe("validateTemplateShape", () => {
  it("accepts a well-formed template", () => {
    expect(
      validateTemplateShape({
        slots: [textSlot("name")],
        renditions: [{ key: "front", label: "Front", width: 100, height: 200, unit: "mm", formats: ["pdf"] }],
      }),
    ).toEqual([]);
  });

  // A duplicate key is accepted by jsonb and only surfaces at render time, as a
  // silently dropped input — which reads as "the value I typed vanished".
  it("rejects duplicate slot keys", () => {
    const problems = validateTemplateShape({ slots: [textSlot("name"), textSlot("name")] });
    expect(problems.join(" ")).toContain("slot keys must be unique");
  });

  it("rejects duplicate rendition keys", () => {
    const r = { label: "F", width: 1, height: 1, unit: "px" as const, formats: ["png" as const] };
    const problems = validateTemplateShape({ renditions: [{ key: "a", ...r }, { key: "a", ...r }] });
    expect(problems.join(" ")).toContain("rendition keys must be unique");
  });

  it("rejects a rendition with no output format", () => {
    const problems = validateTemplateShape({
      renditions: [{ key: "a", label: "A", width: 1, height: 1, unit: "px", formats: [] }],
    });
    expect(problems).toHaveLength(1);
  });

  it("rejects an unknown slot type", () => {
    expect(validateTemplateShape({ slots: [{ type: "video", key: "v", label: "V" }] }).length)
      .toBeGreaterThan(0);
  });

  it("rejects a barcode magnification a scanner could not read", () => {
    const under = validateTemplateShape({
      slots: [{ type: "generated", key: "b", label: "B", generator: "barcode", symbology: "upc-a", magnificationPct: 50 }],
    });
    expect(under.length).toBeGreaterThan(0);
  });

  it("treats absent slots and renditions as empty rather than invalid", () => {
    expect(validateTemplateShape({})).toEqual([]);
  });
});

describe("createTemplate", () => {
  it("starts at version 1, status draft", async () => {
    const c = client();
    const t = await createTemplate(c as unknown as SupabaseLikeClient, {
      key: "beer-label", name: "Beer label", medium: "label", slots: [textSlot("name")],
    });
    expect(t.version).toBe(1);
    expect(t.status).toBe("draft");
  });

  it("refuses to store a template whose slots are invalid", async () => {
    const c = client();
    await expect(
      createTemplate(c as unknown as SupabaseLikeClient, {
        key: "x", name: "X", medium: "label", slots: [textSlot("a"), textSlot("a")],
      }),
    ).rejects.toThrow(/unique/);
    expect(c.rows).toHaveLength(0);
  });
});

describe("updateTemplate", () => {
  it("rejects a patch that would make the slots invalid", async () => {
    const c = client([{ id: "t1", key: "k", version: 1, status: "draft" }]);
    await expect(
      updateTemplate(c as unknown as SupabaseLikeClient, "t1", {
        slots: [textSlot("a"), textSlot("a")],
      }),
    ).rejects.toThrow();
  });
});

describe("publishTemplate", () => {
  it("archives the prior published version before publishing the new one", async () => {
    const c = client([
      { id: "v1", key: "beer-label", version: 1, status: "published", slots: [], renditions: [] },
      { id: "v2", key: "beer-label", version: 2, status: "draft", slots: [], renditions: [] },
    ]);

    await publishTemplate(c as unknown as SupabaseLikeClient, "v2");

    expect(c.rows.find((r) => r.id === "v1")!.status).toBe("archived");
    expect(c.rows.find((r) => r.id === "v2")!.status).toBe("published");
  });

  // The fake enforces the partial unique index, so a publish-then-archive
  // ordering would fail here rather than silently passing.
  it("leaves only one published row per key", async () => {
    const c = client([
      { id: "v1", key: "beer-label", version: 1, status: "published", slots: [], renditions: [] },
      { id: "v2", key: "beer-label", version: 2, status: "draft", slots: [], renditions: [] },
    ]);
    await publishTemplate(c as unknown as SupabaseLikeClient, "v2");
    expect(c.rows.filter((r) => r.status === "published")).toHaveLength(1);
  });

  it("does not touch another key's published version", async () => {
    const c = client([
      { id: "m1", key: "menu", version: 1, status: "published", slots: [], renditions: [] },
      { id: "l1", key: "beer-label", version: 1, status: "draft", slots: [], renditions: [] },
    ]);
    await publishTemplate(c as unknown as SupabaseLikeClient, "l1");
    expect(c.rows.find((r) => r.id === "m1")!.status).toBe("published");
  });

  it("refuses to publish a template with invalid slots", async () => {
    const c = client([
      { id: "t1", key: "k", version: 1, status: "draft", slots: [textSlot("a"), textSlot("a")], renditions: [] },
    ]);
    await expect(publishTemplate(c as unknown as SupabaseLikeClient, "t1")).rejects.toThrow(/Cannot publish/);
    expect(c.rows[0].status).toBe("draft");
  });

  it("throws on a missing template", async () => {
    await expect(publishTemplate(client() as unknown as SupabaseLikeClient, "nope")).rejects.toThrow();
  });
});

describe("draftNextVersion", () => {
  it("copies the published version at version + 1 as a draft", async () => {
    const c = client([
      {
        id: "v1", key: "beer-label", version: 1, status: "published",
        slots: [textSlot("name")], renditions: [], constraints: {}, base_svg_path: "template/beer-label/v1/base.svg",
      },
    ]);

    const next = await draftNextVersion(c as unknown as SupabaseLikeClient, "v1");

    expect(next.version).toBe(2);
    expect(next.status).toBe("draft");
    expect(next.slots).toEqual([textSlot("name")]);
    // The published row must be untouched: outputs point at it.
    expect(c.rows.find((r) => r.id === "v1")!.status).toBe("published");
  });
});

describe("lookups", () => {
  const rows: Partial<BrandTemplate>[] = [
    { id: "v1", key: "beer-label", version: 1, status: "archived", medium: "label" },
    { id: "v2", key: "beer-label", version: 2, status: "published", medium: "label" },
    { id: "m1", key: "menu", version: 1, status: "draft", medium: "menu" },
  ];

  it("getPublishedTemplate returns the live version only", async () => {
    const t = await getPublishedTemplate(client(rows) as unknown as SupabaseLikeClient, "beer-label");
    expect(t?.id).toBe("v2");
  });

  it("getPublishedTemplate returns null when nothing is published", async () => {
    expect(await getPublishedTemplate(client(rows) as unknown as SupabaseLikeClient, "menu")).toBeNull();
  });

  // What an output's (key, version) resolves through — it must keep working
  // after the row is archived, which is the entire reason version is stored.
  it("getTemplateVersion reaches an archived version", async () => {
    const t = await getTemplateVersion(client(rows) as unknown as SupabaseLikeClient, "beer-label", 1);
    expect(t?.id).toBe("v1");
  });

  it("listTemplates filters by medium and status", async () => {
    const c = client(rows) as unknown as SupabaseLikeClient;
    expect(await listTemplates(c, { medium: "menu" })).toHaveLength(1);
    expect(await listTemplates(c, { status: "published" })).toHaveLength(1);
    expect(await listTemplates(c)).toHaveLength(3);
  });
});
