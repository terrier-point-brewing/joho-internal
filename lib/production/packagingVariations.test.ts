// lib/production/packagingVariations.test.ts
import { describe, it, expect } from "vitest";
import { validateFormat, validateBreaksInto } from "./packagingVariations";

// ── validateFormat ──────────────────────────────────────────────────────────
// Pure validator for the (format × paktech_id × tray_id) packaging matrix.
// Returns a human-readable error string when the combination is invalid, or
// null when it is valid. The two I/O helpers in this module (getUnitsPerPackage,
// computeTotalVolumeFlOz) are Supabase round-trips with no extractable pure
// logic, so only validateFormat is characterized here.

describe("validateFormat — paktech formats (4-pack / 6-pack)", () => {
  it.each(["4-pack", "6-pack"])(
    "%s with a paktech and no tray is valid",
    (format) => {
      expect(validateFormat(format, "paktech-1", null)).toBeNull();
    }
  );

  it.each(["4-pack", "6-pack"])(
    "%s requires a paktech_id",
    (format) => {
      expect(validateFormat(format, null, null)).toBe(
        `format "${format}" requires paktech_id`
      );
    }
  );

  it.each(["4-pack", "6-pack"])(
    "%s must not carry a tray_id",
    (format) => {
      // paktech present (so it passes the paktech requirement) but tray also set
      expect(validateFormat(format, "paktech-1", "tray-1")).toBe(
        `format "${format}" must not have tray_id`
      );
    }
  );

  it("reports the missing-paktech error before the tray error when both are wrong", () => {
    // paktech missing AND tray present: the requires-paktech check runs first
    expect(validateFormat("4-pack", null, "tray-1")).toBe(
      `format "4-pack" requires paktech_id`
    );
  });
});

describe("validateFormat — case format", () => {
  // Physically, a case is built by paktech-ing loose cans into 4-packs or
  // 6-packs, then boxing those into a tray — so a case variation carries
  // both components.
  it("case with a paktech and a tray is valid", () => {
    expect(validateFormat("case", "paktech-1", "tray-1")).toBeNull();
  });

  it("case requires a tray_id", () => {
    expect(validateFormat("case", "paktech-1", null)).toBe(
      `format "case" requires tray_id`
    );
  });

  it("case requires a paktech_id", () => {
    // tray present (passes the tray requirement) but paktech missing
    expect(validateFormat("case", null, "tray-1")).toBe(
      `format "case" requires paktech_id`
    );
  });

  it("reports the missing-tray error before the missing-paktech error when both are wrong", () => {
    expect(validateFormat("case", null, null)).toBe(
      `format "case" requires tray_id`
    );
  });
});

describe("validateFormat — loose format", () => {
  it("loose with neither paktech nor tray is valid", () => {
    expect(validateFormat("loose", null, null)).toBeNull();
  });

  it("loose must not carry a paktech_id", () => {
    expect(validateFormat("loose", "paktech-1", null)).toBe(
      `format "loose" must not have paktech_id or tray_id`
    );
  });

  it("loose must not carry a tray_id", () => {
    expect(validateFormat("loose", null, "tray-1")).toBe(
      `format "loose" must not have paktech_id or tray_id`
    );
  });

  it("loose with both paktech and tray is invalid", () => {
    expect(validateFormat("loose", "paktech-1", "tray-1")).toBe(
      `format "loose" must not have paktech_id or tray_id`
    );
  });
});

describe("validateBreaksInto", () => {
  const self = { container_id: "can16", lid_id: "lid1", label_id: "lbl1", partner_id: "cbc" };
  const pack4 = { format: "4-pack", container_id: "can16", lid_id: "lid1", label_id: "lbl1", partner_id: "cbc" };

  it("non-case formats must not set breaks_into_variation_id", () => {
    expect(validateBreaksInto("loose", "v-pack", pack4, self)).toBe(
      `only format "case" may set breaks_into_variation_id`
    );
    expect(validateBreaksInto("4-pack", null, null, self)).toBeNull();
  });

  it("case requires breaks_into_variation_id", () => {
    expect(validateBreaksInto("case", null, null, self)).toBe(
      `format "case" requires breaks_into_variation_id`
    );
  });

  it("case with a valid matching 4-pack/6-pack sibling is valid", () => {
    expect(validateBreaksInto("case", "v-pack", pack4, self)).toBeNull();
    expect(validateBreaksInto("case", "v-pack6", { ...pack4, format: "6-pack" }, self)).toBeNull();
  });

  it("rejects a breaks_into_variation_id that doesn't resolve to an existing row", () => {
    expect(validateBreaksInto("case", "v-ghost", null, self)).toBe(
      "breaks_into_variation_id does not reference an existing variation"
    );
  });

  it("rejects a target that isn't a 4-pack or 6-pack", () => {
    expect(validateBreaksInto("case", "v-loose", { ...pack4, format: "loose" }, self)).toBe(
      `breaks_into_variation_id must reference a 4-pack or 6-pack variation`
    );
    expect(validateBreaksInto("case", "v-case2", { ...pack4, format: "case" }, self)).toBe(
      `breaks_into_variation_id must reference a 4-pack or 6-pack variation`
    );
  });

  it("rejects a target outside the case's can-identity family", () => {
    expect(validateBreaksInto("case", "v-pack", { ...pack4, container_id: "can12" }, self)).toBe(
      `breaks_into_variation_id must reference a variation in the same can-identity family (container/lid/label/partner)`
    );
    expect(validateBreaksInto("case", "v-pack", { ...pack4, lid_id: "other-lid" }, self)).toBe(
      `breaks_into_variation_id must reference a variation in the same can-identity family (container/lid/label/partner)`
    );
    expect(validateBreaksInto("case", "v-pack", { ...pack4, label_id: "other-lbl" }, self)).toBe(
      `breaks_into_variation_id must reference a variation in the same can-identity family (container/lid/label/partner)`
    );
    expect(validateBreaksInto("case", "v-pack", { ...pack4, partner_id: "other-partner" }, self)).toBe(
      `breaks_into_variation_id must reference a variation in the same can-identity family (container/lid/label/partner)`
    );
  });

  it("null-safely matches identity fields (null lid/label/partner on both sides)", () => {
    const genericSelf = { container_id: "keg16", lid_id: null, label_id: null, partner_id: null };
    const genericPack = { format: "4-pack", container_id: "keg16", lid_id: null, label_id: null, partner_id: null };
    expect(validateBreaksInto("case", "v-pack", genericPack, genericSelf)).toBeNull();
  });
});

describe("validateFormat — unknown / fallback formats", () => {
  it("returns null (no constraints) for an unrecognized format", () => {
    // An unknown format matches none of the guarded branches and falls through
    // to the final `return null`, regardless of paktech/tray.
    expect(validateFormat("keg", null, null)).toBeNull();
    expect(validateFormat("keg", "paktech-1", "tray-1")).toBeNull();
  });

  it("returns null for an empty-string format", () => {
    expect(validateFormat("", null, null)).toBeNull();
    expect(validateFormat("", "paktech-1", "tray-1")).toBeNull();
  });
});
