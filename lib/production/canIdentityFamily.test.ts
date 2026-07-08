// lib/production/canIdentityFamily.test.ts
import { describe, it, expect } from "vitest";
import { groupCanFamilies, familyKey, nullSafeEq, type FamilyPackagingRow } from "./canIdentityFamily";

const v = (id: string, format: string, label_id: string | null): FamilyPackagingRow => ({
  id, format, container_id: "c16", lid_id: "silver", label_id, partner_id: "argus",
  total_volume_fl_oz: format === "case" ? 384 : format === "4-pack" ? 64 : 16,
});

describe("groupCanFamilies", () => {
  it("splits Regular (label NULL) from Be Like Mike (label set) even at same container/lid/partner", () => {
    const fams = groupCanFamilies([
      v("reg-loose", "loose", null), v("reg-case", "case", null),
      v("blm-loose", "loose", "belikemike"), v("blm-case", "case", "belikemike"),
    ]);
    expect(fams).toHaveLength(2);
    const ids = fams.map((f) => f.map((x) => x.id).sort());
    expect(ids).toContainEqual(["reg-case", "reg-loose"]);
    expect(ids).toContainEqual(["blm-case", "blm-loose"]);
  });

  it("ignores non-can formats", () => {
    const fams = groupCanFamilies([v("reg-loose", "loose", null), { ...v("keg", "keg" as string, null) }]);
    expect(fams.flat().map((x) => x.id)).toEqual(["reg-loose"]);
  });
});

describe("nullSafeEq / familyKey", () => {
  it("treats null and undefined as equal", () => {
    expect(nullSafeEq(null, undefined)).toBe(true);
    expect(nullSafeEq("a", "a")).toBe(true);
    expect(nullSafeEq("a", null)).toBe(false);
  });
  it("familyKey is stable for the same identity tuple", () => {
    expect(familyKey(v("x", "loose", null))).toBe(familyKey(v("y", "case", null)));
  });
});
