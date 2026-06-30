// lib/production/packagingVariations.test.ts
import { describe, it, expect } from "vitest";
import { validateFormat } from "./packagingVariations";

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
