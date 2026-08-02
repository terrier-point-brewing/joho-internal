import { describe, expect, it } from "vitest";
import {
  getDraft,
  listVersions,
  nextVersionLabel,
  publishDraft,
  saveDraft,
  saveDraftSection,
  validateCanonForPublish,
} from "./canonWorkflow";
import { seedCanon } from "./seedCanon";
import { withIds } from "./canonIds";
import type { BrandCanon } from "./canon.types";

describe("nextVersionLabel", () => {
  it("returns 1.0 when current is null", () => {
    expect(nextVersionLabel(null)).toBe("1.0");
  });

  it("bumps the minor version", () => {
    expect(nextVersionLabel("1.0")).toBe("1.1");
  });

  it("bumps the minor version as an integer past single digits", () => {
    expect(nextVersionLabel("1.9")).toBe("1.10");
  });
});

// A minimal fake Supabase-like client covering the query shapes canonWorkflow
// needs: from().select().eq().limit() (read; also used by saveDraft to check
// for an existing draft), from().insert() (saveDraft's insert path,
// publishDraft's new published/archived rows), from().update().eq()
// (saveDraft's update path, publishDraft's archive step),
// from().delete().eq() (publishDraft removing the draft row), and
// from().select().in().order() (listVersions). Configurable per test via
// `rows` (the current table contents) so each function can be driven
// end-to-end against fake state.
interface Row {
  id: string;
  version_label: string;
  status: "draft" | "published" | "archived";
  document: unknown;
  changelog?: string;
  published_at?: string | null;
}

//
// `failOn` makes a given operation return a Postgres-style error instead of
// succeeding — Supabase's client resolves rather than throws on a failed
// write, so this is the only way to exercise the error branches.
interface FailOn {
  select?: boolean;
  insert?: boolean;
  update?: boolean;
  delete?: boolean;
}

function fakeClient(initialRows: Row[], failOn: FailOn = {}) {
  const rows: Row[] = [...initialRows];
  let idCounter = rows.length;
  const pgError = (op: string) => ({
    code: "PGRST204",
    message: `Could not find the 'updated_at' column of 'brand_canon_versions' in the schema cache (${op})`,
  });

  return {
    rows,
    from() {
      return {
        select(_cols: string) {
          return {
            eq(column: string, value: string) {
              const filtered = rows.filter((r) => (r as never)[column] === value);
              return {
                limit(n: number) {
                  if (failOn.select) return Promise.resolve({ data: null, error: pgError("select") });
                  return Promise.resolve({ data: filtered.slice(0, n), error: null });
                },
              };
            },
            in(column: string, values: string[]) {
              const filtered = rows.filter((r) => values.includes((r as never)[column]));
              return {
                order() {
                  return Promise.resolve({
                    data: [...filtered].sort((a, b) => (a.published_at ?? "") < (b.published_at ?? "") ? 1 : -1),
                    error: null,
                  });
                },
              };
            },
          };
        },
        insert(row: Partial<Row>) {
          if (failOn.insert) return Promise.resolve({ error: pgError("insert") });
          // Enforce the brand_canon_one_published partial unique index so a
          // publish that inserts a 2nd published row before archiving the
          // prior one fails here (as it would in Postgres).
          if (row.status === "published" && rows.some((r) => r.status === "published")) {
            return Promise.resolve({ error: new Error("duplicate published row (one-published index)") });
          }
          rows.push({ id: `id-${idCounter++}`, ...row } as Row);
          return Promise.resolve({ error: null });
        },
        update(patch: Partial<Row>) {
          return {
            eq(column: string, value: string) {
              if (failOn.update) return Promise.resolve({ error: pgError("update") });
              rows.forEach((r, i) => {
                if ((r as never)[column] === value) rows[i] = { ...r, ...patch };
              });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            eq(column: string, value: string) {
              if (failOn.delete) return Promise.resolve({ error: pgError("delete") });
              const idx = rows.findIndex((r) => (r as never)[column] === value);
              if (idx >= 0) rows.splice(idx, 1);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

describe("getDraft", () => {
  it("returns the existing draft row's document", async () => {
    const custom: BrandCanon = { ...seedCanon, brandName: "Existing Draft" };
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: custom }]);
    const result = await getDraft(client as never);
    expect(result.brandName).toBe("Existing Draft");
  });

  it("seeds a new draft from the current published row when none exists", async () => {
    const published: BrandCanon = { ...seedCanon, brandName: "Published" };
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "published", document: published, published_at: "2026-01-01" },
    ]);
    const result = await getDraft(client as never);
    expect(result.brandName).toBe("Published");
    expect(client.rows.some((r) => r.status === "draft")).toBe(true);
  });

  it("seeds a new draft from seedCanon when no rows at all exist", async () => {
    const client = fakeClient([]);
    const result = await getDraft(client as never);
    // Equal to the seed except for the ids getDraft backfills on read.
    expect(result).toEqual(expect.objectContaining({ brandName: seedCanon.brandName }));
    expect(result.values.map((v) => v.title)).toEqual(seedCanon.values.map((v) => v.title));
    expect(client.rows.some((r) => r.status === "draft")).toBe(true);
  });

  it("backfills stable ids onto a stored draft that has none", async () => {
    const noIds = JSON.parse(
      JSON.stringify(seedCanon, (k, v) => (k === "id" ? undefined : v)),
    ) as BrandCanon;
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: noIds },
    ]);

    const result = await getDraft(client as never);

    for (const v of result.values) expect(v.id).toBeTruthy();
    // …and persists them, so the next read is stable rather than re-generating.
    const stored = client.rows.find((r) => r.status === "draft")!.document as BrandCanon;
    expect(stored.values.map((v) => v.id)).toEqual(result.values.map((v) => v.id));
  });

  it("does not rewrite the draft row when ids are already present", async () => {
    const seeded = (await getDraft(fakeClient([]) as never)) as BrandCanon;
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: seeded },
    ]);
    const before = JSON.stringify(client.rows[0]);

    await getDraft(client as never);

    expect(JSON.stringify(client.rows[0])).toBe(before);
  });
});

describe("validateCanonForPublish", () => {
  it("accepts a valid canon and hands back the parsed document", () => {
    const result = validateCanonForPublish(seedCanon);
    expect(result.ok).toBe(true);
    expect(result.ok && result.canon.brandName).toBe(seedCanon.brandName);
  });

  it("attributes an unowned key's issue to 'other'", () => {
    // `brandName` is one of the three keys still owned by no subtab
    // (brandName · version · visibility), so its issues have nowhere to route.
    const broken = { ...seedCanon, brandName: 42 as unknown as string };
    const result = validateCanonForPublish(broken);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe("brandName");
    expect(result.issues[0].section).toBe("other");
  });

  // `naming` routes to the subtab that edits it (release, since the Release
  // Design extraction) instead of falling through to 'other'.
  it("attributes a naming issue to the release subtab", () => {
    const broken = {
      ...seedCanon,
      naming: { ...seedCanon.naming, criteria: ["one", "two", "three"] },
    };
    const result = validateCanonForPublish(broken);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].path).toBe("naming.criteria");
    expect(result.issues[0].section).toBe("release");
  });

  it("attributes a color-section issue to the color subtab", () => {
    const roleMap = { ...seedCanon.roleMap, light: { ...seedCanon.roleMap.light } };
    delete (roleMap.light as Record<string, unknown>).accent;
    const result = validateCanonForPublish({ ...seedCanon, roleMap });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.section === "color")).toBe(true);
  });

  it("reports every independent breakage, not just the first", () => {
    const roleMap = { ...seedCanon.roleMap, light: { ...seedCanon.roleMap.light } };
    delete (roleMap.light as Record<string, unknown>).accent;
    const result = validateCanonForPublish({
      ...seedCanon,
      roleMap,
      naming: { ...seedCanon.naming, criteria: ["one"] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(new Set(result.issues.map((i) => i.section))).toEqual(new Set(["color", "release"]));
  });

  it("gives each issue a human-readable message", () => {
    const result = validateCanonForPublish({
      ...seedCanon,
      naming: { ...seedCanon.naming, criteria: ["one"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].message.length).toBeGreaterThan(0);
  });
});

describe("publishDraft validation", () => {
  it("refuses to publish an invalid draft", async () => {
    const broken = {
      ...seedCanon,
      naming: { ...seedCanon.naming, criteria: ["one", "two"] },
    };
    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: broken },
    ]);

    await expect(publishDraft(client as never, {})).rejects.toThrow();
  });

  it("does not archive the prior published row when validation fails", async () => {
    const broken = {
      ...seedCanon,
      naming: { ...seedCanon.naming, criteria: ["one", "two"] },
    };
    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: broken },
      {
        id: "p1",
        version_label: "1.0",
        status: "published",
        document: seedCanon,
        published_at: "2026-01-01",
      },
    ]);

    await expect(publishDraft(client as never, {})).rejects.toThrow();

    // A partial publish (archived the old, inserted nothing) would leave the
    // brand with no live canon at all.
    expect(client.rows.find((r) => r.id === "p1")!.status).toBe("published");
    expect(client.rows.filter((r) => r.status === "published")).toHaveLength(1);
  });

  it("names the offending subtab in the thrown message", async () => {
    const roleMap = { ...seedCanon.roleMap, light: { ...seedCanon.roleMap.light } };
    delete (roleMap.light as Record<string, unknown>).accent;
    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: { ...seedCanon, roleMap } },
    ]);

    await expect(publishDraft(client as never, {})).rejects.toThrow(/color/i);
  });
});

describe("publishDraft changelog generation", () => {
  function withPalette(hex: string): BrandCanon {
    const canon = withIds(seedCanon).canon;
    canon.palette[2] = { ...canon.palette[2], hex };
    return canon;
  }

  it("generates a changelog naming the changed color, with no typing", async () => {
    const published = withIds(seedCanon).canon;
    const draft = structuredClone(published);
    draft.palette[2].hex = "#a51829";

    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: draft },
      {
        id: "p1",
        version_label: "1.0",
        status: "published",
        document: published,
        published_at: "2026-01-01",
      },
    ]);

    await publishDraft(client as never, {});

    const row = client.rows.find((r) => r.status === "published" && r.id !== "p1")!;
    expect(row.changelog).toContain("Seal Red");
    expect(row.changelog).toContain("#a51829");
    expect((row as { change_entries?: unknown[] }).change_entries).toHaveLength(1);
  });

  it("keeps a founder note alongside the generated text rather than replacing it", async () => {
    const published = withIds(seedCanon).canon;
    const draft = structuredClone(published);
    draft.palette[2].hex = "#a51829";

    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: draft },
      {
        id: "p1",
        version_label: "1.0",
        status: "published",
        document: published,
        published_at: "2026-01-01",
      },
    ]);

    await publishDraft(client as never, { changelog: "Approved by founder 30 Jul." });

    const row = client.rows.find((r) => r.status === "published" && r.id !== "p1")!;
    expect(row.changelog).toContain("Approved by founder 30 Jul.");
    expect(row.changelog).toContain("Seal Red");
  });

  it("publishes a first version with no prior published row", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: withPalette("#ad1a2d") },
    ]);

    await publishDraft(client as never, {});

    const row = client.rows.find((r) => r.status === "published")!;
    expect((row as { change_entries?: unknown[] }).change_entries!.length).toBeGreaterThan(0);
    expect(row.changelog).toContain("published for the first time");
  });

  it("diffs against the pre-archive published document", async () => {
    // If the diff ran after the archive step it would compare the draft against
    // nothing and report a first publish, losing the real change list.
    const published = withIds(seedCanon).canon;
    const draft = structuredClone(published);
    draft.values[0].title = "Retitled value";

    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: draft },
      {
        id: "p1",
        version_label: "1.0",
        status: "published",
        document: published,
        published_at: "2026-01-01",
      },
    ]);

    await publishDraft(client as never, {});

    const row = client.rows.find((r) => r.status === "published" && r.id !== "p1")!;
    expect(row.changelog).toContain("Retitled value");
    expect(row.changelog).not.toContain("published for the first time");
  });

  it("records an empty entry list when nothing changed", async () => {
    const published = withIds(seedCanon).canon;
    const client = fakeClient([
      { id: "d1", version_label: "", status: "draft", document: structuredClone(published) },
      {
        id: "p1",
        version_label: "1.0",
        status: "published",
        document: published,
        published_at: "2026-01-01",
      },
    ]);

    await publishDraft(client as never, {});

    const row = client.rows.find((r) => r.status === "published" && r.id !== "p1")!;
    expect((row as { change_entries?: unknown[] }).change_entries).toEqual([]);
  });
});

describe("saveDraftSection", () => {
  // A stored draft whose `naming` block is invalid against the full canon
  // schema (criteria must be exactly 5). Before section-scoped saving this
  // made EVERY save from EVERY subtab fail, because saveDraft ran
  // canonSchema.parse() over the whole document.
  function draftWithBrokenNaming(): BrandCanon {
    return {
      ...seedCanon,
      naming: { ...seedCanon.naming, criteria: ["only", "three", "criteria"] as never },
    };
  }

  it("saves one section while an unrelated section is invalid", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: draftWithBrokenNaming() },
    ]);

    const values = [{ n: "1", title: "Rewritten", means: "m", cost: "c" }];
    await expect(saveDraftSection(client as never, "ethos", { values })).resolves.toBeUndefined();

    const stored = client.rows.find((r) => r.status === "draft")!.document as BrandCanon;
    expect(stored.values[0].title).toBe("Rewritten");
  });

  it("leaves every key outside the section byte-identical", async () => {
    // Start from an id-bearing document so the getDraft backfill is a no-op and
    // the comparison below is genuinely exact rather than "equal except ids".
    const original = withIds(seedCanon).canon;
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: original },
    ]);

    await saveDraftSection(client as never, "ethos", {
      values: [{ n: "1", title: "Only this changes", means: "m", cost: "c" }],
    });

    const stored = client.rows.find((r) => r.status === "draft")!.document as BrandCanon;
    expect(stored.voice).toEqual(original.voice);
    expect(stored.palette).toEqual(original.palette);
    expect(stored.naming).toEqual(original.naming);
    expect(stored.visibility).toEqual(original.visibility);
    expect(stored.brandName).toBe(original.brandName);
  });

  it("refuses a patch carrying another section's key", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: seedCanon },
    ]);

    await expect(
      saveDraftSection(client as never, "ethos", { voice: seedCanon.voice } as never),
    ).rejects.toThrow(/voice/);
  });

  it("rejects a patch whose own key is malformed", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: seedCanon },
    ]);

    await expect(
      saveDraftSection(client as never, "ethos", { values: "nope" } as never),
    ).rejects.toThrow();
  });

  it("merges only this subtab's guideIntros entry, leaving the others intact", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: seedCanon },
    ]);

    await saveDraftSection(client as never, "ethos", {
      guideIntros: { ethos: "New ethos intro" },
    });

    const stored = client.rows.find((r) => r.status === "draft")!.document as BrandCanon;
    expect(stored.guideIntros?.ethos).toBe("New ethos intro");
    expect(stored.guideIntros?.voice).toBe(seedCanon.guideIntros?.voice);
    expect(stored.guideIntros?.color).toBe(seedCanon.guideIntros?.color);
  });

  it("refuses a guideIntros patch targeting a different subtab", async () => {
    const client = fakeClient([
      { id: "d1", version_label: "1.0", status: "draft", document: seedCanon },
    ]);

    await expect(
      saveDraftSection(client as never, "ethos", { guideIntros: { voice: "sneaky" } }),
    ).rejects.toThrow(/voice/);
  });

  it("surfaces a failed write instead of reporting success", async () => {
    // Ids pre-assigned so the only update this test can trip is the section
    // write itself — otherwise the id-backfill update fails first and we'd be
    // asserting on the wrong error.
    const client = fakeClient(
      [{ id: "d1", version_label: "1.0", status: "draft", document: withIds(seedCanon).canon }],
      { update: true },
    );

    await expect(
      saveDraftSection(client as never, "ethos", {
        values: [{ n: "1", title: "t", means: "m", cost: "c" }],
      }),
    ).rejects.toThrow(/save the canon draft section/);
  });

  it("creates a draft first when none exists, then applies the patch", async () => {
    const client = fakeClient([]);

    await saveDraftSection(client as never, "ethos", {
      values: [{ n: "1", title: "From nothing", means: "m", cost: "c" }],
    });

    const drafts = client.rows.filter((r) => r.status === "draft");
    expect(drafts).toHaveLength(1);
    expect((drafts[0].document as BrandCanon).values[0].title).toBe("From nothing");
  });
});

describe("saveDraft", () => {
  it("updates the existing draft in place without creating a second draft", async () => {
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: seedCanon }]);
    const updated: BrandCanon = { ...seedCanon, brandName: "Updated" };
    await saveDraft(client as never, updated);
    const draftRows = client.rows.filter((r) => r.status === "draft");
    expect(draftRows).toHaveLength(1);
    expect((draftRows[0]?.document as BrandCanon).brandName).toBe("Updated");
  });

  it("inserts a draft when none exists yet", async () => {
    const client = fakeClient([]);
    const updated: BrandCanon = { ...seedCanon, brandName: "Fresh" };
    await saveDraft(client as never, updated);
    const draftRows = client.rows.filter((r) => r.status === "draft");
    expect(draftRows).toHaveLength(1);
    expect((draftRows[0]?.document as BrandCanon).brandName).toBe("Fresh");
  });

  it("rejects an invalid document", async () => {
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: seedCanon }]);
    const { brandName: _brandName, ...invalid } = seedCanon;
    await expect(saveDraft(client as never, invalid)).rejects.toThrow();
  });

  // Regression: prod was missing migration 20260809 (no `updated_at` column),
  // so every draft update came back PGRST204. The error was discarded, the
  // route answered { ok: true }, and Publish then snapshotted a draft that had
  // never changed — the guide silently refused to save. A write that fails must
  // throw, never report success.
  it("throws when the update fails instead of reporting success", async () => {
    const client = fakeClient(
      [{ id: "d1", version_label: "1.0", status: "draft", document: seedCanon }],
      { update: true },
    );
    const updated: BrandCanon = { ...seedCanon, brandName: "Updated" };
    await expect(saveDraft(client as never, updated)).rejects.toThrow(/updated_at/);
  });

  it("throws when the insert fails instead of reporting success", async () => {
    const client = fakeClient([], { insert: true });
    await expect(saveDraft(client as never, seedCanon)).rejects.toThrow(/updated_at/);
  });

  it("throws when the existing-draft lookup fails", async () => {
    const client = fakeClient([], { select: true });
    await expect(saveDraft(client as never, seedCanon)).rejects.toThrow(/updated_at/);
  });
});

describe("publishDraft", () => {
  it("publishes the draft, archives the prior published row, and deletes the draft", async () => {
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "published", document: seedCanon, published_at: "2026-01-01" },
      { id: "d1", version_label: "", status: "draft", document: { ...seedCanon, brandName: "Draft Edit" } },
    ]);
    const result = await publishDraft(client as never, {});
    expect(result.versionLabel).toBe("1.1");
    expect(client.rows.some((r) => r.status === "draft")).toBe(false);
    expect(client.rows.find((r) => r.id === "p1")?.status).toBe("archived");
    const published = client.rows.find((r) => r.status === "published");
    expect((published?.document as BrandCanon).brandName).toBe("Draft Edit");
    expect(published?.version_label).toBe("1.1");
  });

  // Same class of bug as saveDraft's: a swallowed error here would archive the
  // old version, leave the draft in place, and report a version label that was
  // never published.
  it("throws when archiving the prior published row fails", async () => {
    const client = fakeClient(
      [
        { id: "p1", version_label: "1.0", status: "published", document: seedCanon, published_at: "2026-01-01" },
        { id: "d1", version_label: "", status: "draft", document: seedCanon },
      ],
      { update: true },
    );
    await expect(publishDraft(client as never, {})).rejects.toThrow(/updated_at/);
  });

  it("throws when deleting the consumed draft fails", async () => {
    const client = fakeClient(
      [{ id: "d1", version_label: "", status: "draft", document: seedCanon }],
      { delete: true },
    );
    await expect(publishDraft(client as never, {})).rejects.toThrow(/updated_at/);
  });
});

describe("getDraft", () => {
  it("throws when the draft lookup fails instead of silently seeding a new draft", async () => {
    const client = fakeClient([], { select: true });
    await expect(getDraft(client as never)).rejects.toThrow(/updated_at/);
  });

  it("throws when seeding a new draft fails", async () => {
    const client = fakeClient([], { insert: true });
    await expect(getDraft(client as never)).rejects.toThrow(/updated_at/);
  });
});

describe("listVersions", () => {
  it("returns published and archived rows, newest first", async () => {
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "archived", document: seedCanon, published_at: "2026-01-01" },
      { id: "p2", version_label: "1.1", status: "published", document: seedCanon, published_at: "2026-02-01" },
    ]);
    const result = await listVersions(client as never);
    expect(result.map((r) => r.version_label)).toEqual(["1.1", "1.0"]);
  });
});
