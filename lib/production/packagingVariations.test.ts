// lib/production/packagingVariations.test.ts
import { describe, it, expect } from "vitest";
import { validateFormat, needsPaktech, needsTray, isDuplicateCombo, type VariationCombo } from "./packagingVariations";

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
  it("case with a tray and no paktech is valid", () => {
    expect(validateFormat("case", null, "tray-1")).toBeNull();
  });

  it("case requires a tray_id", () => {
    expect(validateFormat("case", null, null)).toBe(
      `format "case" requires tray_id`
    );
  });

  it("case must not carry a paktech_id", () => {
    // tray present (passes the tray requirement) but paktech also set
    expect(validateFormat("case", "paktech-1", "tray-1")).toBe(
      `format "case" must not have paktech_id`
    );
  });

  it("reports the missing-tray error before the paktech error when both are wrong", () => {
    // tray missing AND paktech present: the requires-tray check runs first
    expect(validateFormat("case", "paktech-1", null)).toBe(
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

describe("needsPaktech / needsTray", () => {
  it("needsPaktech is true only for 4-pack and 6-pack", () => {
    expect(needsPaktech("4-pack")).toBe(true);
    expect(needsPaktech("6-pack")).toBe(true);
    expect(needsPaktech("loose")).toBe(false);
    expect(needsPaktech("case")).toBe(false);
  });

  it("needsTray is true only for case", () => {
    expect(needsTray("case")).toBe(true);
    expect(needsTray("loose")).toBe(false);
    expect(needsTray("4-pack")).toBe(false);
    expect(needsTray("6-pack")).toBe(false);
  });
});

describe("isDuplicateCombo", () => {
  const base: VariationCombo = {
    container_id: "c1",
    format: "4-pack",
    lid_id: "lid1",
    paktech_id: "pak1",
    tray_id: null,
    label_id: "lab1",
    partner_id: "p1",
  };

  it("matches an identical combo", () => {
    expect(isDuplicateCombo(base, [{ ...base }])).toBe(true);
  });

  it("does not match when container_id differs", () => {
    expect(isDuplicateCombo(base, [{ ...base, container_id: "c2" }])).toBe(false);
  });

  it("does not match when format differs", () => {
    expect(isDuplicateCombo(base, [{ ...base, format: "6-pack" }])).toBe(false);
  });

  it("does not match when lid_id differs", () => {
    expect(isDuplicateCombo(base, [{ ...base, lid_id: "lid2" }])).toBe(false);
  });

  it("does not match when paktech_id differs (including null vs set)", () => {
    expect(isDuplicateCombo(base, [{ ...base, paktech_id: null }])).toBe(false);
  });

  it("does not match when tray_id differs (including null vs set)", () => {
    expect(isDuplicateCombo(base, [{ ...base, tray_id: "tray1" }])).toBe(false);
  });

  it("does not match when label_id differs (including null vs set)", () => {
    expect(isDuplicateCombo(base, [{ ...base, label_id: null }])).toBe(false);
  });

  it("does not match when partner_id differs (including null vs set)", () => {
    expect(isDuplicateCombo(base, [{ ...base, partner_id: null }])).toBe(false);
  });

  it("matches when both candidate and an existing row have null optional fields", () => {
    const loose: VariationCombo = {
      container_id: "c1",
      format: "loose",
      lid_id: "lid1",
      paktech_id: null,
      tray_id: null,
      label_id: null,
      partner_id: null,
    };
    expect(isDuplicateCombo(loose, [{ ...loose }])).toBe(true);
  });

  it("returns false against an empty existing list", () => {
    expect(isDuplicateCombo(base, [])).toBe(false);
  });

  it("returns true when any one of several existing rows matches", () => {
    const other: VariationCombo = { ...base, container_id: "c2" };
    expect(isDuplicateCombo(base, [other, { ...base }])).toBe(true);
  });
});
