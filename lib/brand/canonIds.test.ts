import { describe, expect, it } from "vitest";
import { withIds } from "./canonIds";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

// Strips every id from a canon so tests start from a pre-migration document.
function stripIds(canon: BrandCanon): BrandCanon {
  return JSON.parse(
    JSON.stringify(canon, (key, value) => (key === "id" ? undefined : value)),
  ) as BrandCanon;
}

describe("withIds", () => {
  it("assigns an id to every list item that lacks one", () => {
    const { canon, changed } = withIds(stripIds(seedCanon));

    expect(changed).toBe(true);
    for (const v of canon.values) expect(v.id).toBeTruthy();
    for (const s of canon.voice.sliders) expect(s.id).toBeTruthy();
    for (const r of canon.voice.rewrites) expect(r.id).toBeTruthy();
    for (const c of canon.palette) expect(c.id).toBeTruthy();
    for (const f of canon.fonts) expect(f.id).toBeTruthy();
  });

  it("is idempotent — a second pass changes nothing", () => {
    const first = withIds(stripIds(seedCanon));
    const second = withIds(first.canon);

    expect(second.changed).toBe(false);
    expect(second.canon.values.map((v) => v.id)).toEqual(first.canon.values.map((v) => v.id));
    expect(second.canon.palette.map((c) => c.id)).toEqual(first.canon.palette.map((c) => c.id));
  });

  it("never regenerates an id that already exists", () => {
    const seeded = stripIds(seedCanon);
    seeded.values[0].id = "keep-me";

    const { canon } = withIds(seeded);
    expect(canon.values[0].id).toBe("keep-me");
  });

  it("assigns distinct ids to distinct items", () => {
    const { canon } = withIds(stripIds(seedCanon));
    const ids = canon.values.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports changed: false when every item already has an id", () => {
    const { canon } = withIds(stripIds(seedCanon));
    expect(withIds(canon).changed).toBe(false);
  });

  it("covers nested mark variants", () => {
    const seeded = stripIds(seedCanon);
    if (!seeded.marks?.length) throw new Error("seed has no marks — fixture assumption broken");

    const { canon } = withIds(seeded);
    for (const mark of canon.marks ?? []) {
      expect(mark.id).toBeTruthy();
      for (const variant of mark.variants) expect(variant.id).toBeTruthy();
    }
  });

  it("does not throw when an optional list is absent", () => {
    const seeded = stripIds(seedCanon);
    delete seeded.marks;

    expect(() => withIds(seeded)).not.toThrow();
    expect(withIds(seeded).canon.marks).toBeUndefined();
  });

  it("leaves non-list fields untouched", () => {
    const seeded = stripIds(seedCanon);
    const { canon } = withIds(seeded);

    expect(canon.brandName).toBe(seeded.brandName);
    expect(canon.naming).toEqual(seeded.naming);
    expect(canon.roleMap).toEqual(seeded.roleMap);
  });
});
