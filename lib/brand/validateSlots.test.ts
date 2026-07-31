import { describe, expect, it } from "vitest";
import {
  gtinCheckDigit,
  hasBlockingIssues,
  isValidGtin,
  validateSlotInputs,
  type SlotIssue,
  type ValidationContext,
} from "./validateSlots";
import type { Slot } from "./slots";

const errors = (issues: SlotIssue[]) => issues.filter((i) => i.severity === "error");
const keys = (issues: SlotIssue[]) => issues.map((i) => i.slotKey).sort();

describe("gtinCheckDigit / isValidGtin", () => {
  // Known-good codes from the GS1 specification. These are the anchor: the
  // weighting is anchored to the RIGHTMOST digit, not to a fixed length, which
  // is the detail an off-by-one implementation gets wrong while still looking
  // plausible on one of the two lengths.
  it("computes the published check digit for a UPC-A", () => {
    expect(gtinCheckDigit("03600029145")).toBe(2);
    expect(isValidGtin("036000291452")).toBe(true);
  });

  it("computes the published check digit for an EAN-13", () => {
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(isValidGtin("4006381333931")).toBe(true);
  });

  it("rejects a code whose check digit is off by one", () => {
    expect(isValidGtin("036000291453")).toBe(false);
    expect(isValidGtin("4006381333932")).toBe(false);
  });

  it("rejects non-digits and stubs", () => {
    expect(isValidGtin("03600029145X")).toBe(false);
    expect(isValidGtin("")).toBe(false);
    expect(isValidGtin("7")).toBe(false);
  });
});

describe("validateSlotInputs — required", () => {
  const slots: Slot[] = [
    { type: "text", key: "name", label: "Release name", required: true, fontRole: "display", fit: "shrink" },
    { type: "text", key: "flavor", label: "Flavor text", required: false, fontRole: "body", fit: "wrap" },
  ];

  it("flags a missing required slot and ignores a missing optional one", () => {
    const issues = validateSlotInputs(slots, {});
    expect(keys(errors(issues))).toEqual(["name"]);
  });

  it("treats whitespace as missing", () => {
    expect(errors(validateSlotInputs(slots, { name: "   " }))).toHaveLength(1);
  });

  it("passes when the required slot is filled", () => {
    expect(errors(validateSlotInputs(slots, { name: "Drifting Through the Clouds" }))).toHaveLength(0);
  });
});

describe("validateSlotInputs — text fit", () => {
  const reject: Slot = {
    type: "text", key: "name", label: "Release name", required: true,
    fontRole: "display", fit: "reject", maxChars: 10,
  };
  const shrink: Slot = { ...reject, fit: "shrink" };

  it("errors when a non-reflowing slot overflows", () => {
    const issues = validateSlotInputs([reject], { name: "a".repeat(14) });
    expect(errors(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("4 characters over");
  });

  it("only warns when the slot can shrink — the render still happens", () => {
    const issues = validateSlotInputs([shrink], { name: "a".repeat(11) });
    expect(errors(issues)).toHaveLength(0);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("1 character over");
    expect(hasBlockingIssues(issues)).toBe(false);
  });
});

describe("validateSlotInputs — color must be a token", () => {
  const slot: Slot = { type: "color", key: "ground", label: "Background", required: true };
  const ctx: ValidationContext = { roleNames: ["canvas", "accent"], paletteKeys: ["indigo", "paper"] };

  it("rejects a literal hex even when it matches the current token value", () => {
    const issues = validateSlotInputs([slot], { ground: "#26355d" }, ctx);
    expect(errors(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("must reference a brand token");
  });

  it.each(["#fff", "rgb(38,53,93)", "rgba(0,0,0,1)", "hsl(220 40% 26%)"])(
    "rejects the literal form %s",
    (literal) => {
      expect(errors(validateSlotInputs([slot], { ground: literal }, ctx))).toHaveLength(1);
    },
  );

  it("accepts a role name and a palette key", () => {
    expect(errors(validateSlotInputs([slot], { ground: "canvas" }, ctx))).toHaveLength(0);
    expect(errors(validateSlotInputs([slot], { ground: "indigo" }, ctx))).toHaveLength(0);
  });

  it("rejects a token that is not in the canon", () => {
    const issues = validateSlotInputs([slot], { ground: "chartreuse" }, ctx);
    expect(errors(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("not a brand role or palette key");
  });

  it("honours a per-slot allow list", () => {
    const restricted: Slot = { ...slot, allowed: ["accent"] };
    expect(errors(validateSlotInputs([restricted], { ground: "canvas" }, ctx))).toHaveLength(1);
    expect(errors(validateSlotInputs([restricted], { ground: "accent" }, ctx))).toHaveLength(0);
  });
});

describe("validateSlotInputs — assets", () => {
  const slot: Slot = {
    type: "asset", key: "art", label: "Hero artwork", required: true, kind: "label_art",
  };
  const ctx: ValidationContext = {
    assets: [
      { id: "a1", kind: "label_art", status: "approved" },
      { id: "a2", kind: "wordmark", status: "approved" },
      { id: "a3", kind: "label_art", status: "draft" },
    ],
  };

  it("accepts an approved asset of the declared kind", () => {
    expect(errors(validateSlotInputs([slot], { art: "a1" }, ctx))).toHaveLength(0);
  });

  it("rejects the wrong kind", () => {
    expect(errors(validateSlotInputs([slot], { art: "a2" }, ctx))).toHaveLength(1);
  });

  it("rejects an unapproved asset", () => {
    const issues = validateSlotInputs([slot], { art: "a3" }, ctx);
    expect(issues[0].message).toContain("draft, not approved");
  });

  it("rejects a dangling reference", () => {
    expect(errors(validateSlotInputs([slot], { art: "gone" }, ctx))).toHaveLength(1);
  });
});

describe("validateSlotInputs — motif resolves from the season", () => {
  const slots: Slot[] = [
    { type: "motif", key: "ground", label: "Season background", required: true, resolves: "background" },
    { type: "motif", key: "chop", label: "Season chop", required: true, resolves: "chop-glyph" },
  ];

  it("errors on every motif slot when no season is active", () => {
    const issues = errors(validateSlotInputs(slots, {}, { season: null }));
    expect(keys(issues)).toEqual(["chop", "ground"]);
    expect(issues[0].message).toContain("no season is active");
  });

  it("errors only for the part the season has not defined", () => {
    const issues = errors(
      validateSlotInputs(slots, {}, { season: { backgroundHex: "#26355d", chopGlyphAssetId: null } }),
    );
    expect(keys(issues)).toEqual(["chop"]);
  });

  it("passes when the season defines both", () => {
    const issues = validateSlotInputs(
      slots, {}, { season: { backgroundHex: "#26355d", chopGlyphAssetId: "a1" } },
    );
    expect(errors(issues)).toHaveLength(0);
  });

  it("does not require author input — a motif is never typed", () => {
    const issues = validateSlotInputs(slots, {}, {
      season: { backgroundHex: "#26355d", chopGlyphAssetId: "a1" },
    });
    expect(issues).toHaveLength(0);
  });
});

describe("validateSlotInputs — barcode", () => {
  const slot: Slot = {
    type: "generated", key: "barcode", label: "Barcode", required: true,
    generator: "barcode", symbology: "upc-a", magnificationPct: 100,
  };

  it("accepts a valid UPC-A", () => {
    expect(errors(validateSlotInputs([slot], { barcode: "036000291452" }))).toHaveLength(0);
  });

  // The whole reason `generated` is its own slot type: this renders cleanly and
  // never scans, so nothing catches it downstream.
  it("rejects a bad check digit and says what the digit should be", () => {
    const issues = validateSlotInputs([slot], { barcode: "036000291453" });
    expect(errors(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("will not scan");
    expect(issues[0].message).toContain("Expected 2");
  });

  it("rejects the wrong digit count for the symbology", () => {
    const issues = validateSlotInputs([slot], { barcode: "4006381333931" });
    expect(issues[0].message).toContain("must be 12 digits for UPC-A");
  });

  it("accepts a valid EAN-13 on an EAN-13 slot", () => {
    const ean: Slot = { ...slot, symbology: "ean-13" };
    expect(errors(validateSlotInputs([ean], { barcode: "4006381333931" }))).toHaveLength(0);
  });

  it("rejects non-digits", () => {
    expect(errors(validateSlotInputs([slot], { barcode: "03600029145X" }))).toHaveLength(1);
  });
});

describe("validateSlotInputs — images", () => {
  const slot: Slot = {
    type: "image", key: "hero", label: "Hero artwork", required: true, aspect: 1.5, minDpi: 300,
  };

  it("errors below the print resolution floor", () => {
    const issues = validateSlotInputs([slot], { hero: { aspect: 1.5, dpi: 150 } });
    expect(errors(issues)).toHaveLength(1);
    expect(issues[0].message).toContain("needs at least 300 DPI");
  });

  it("warns but does not block on an aspect mismatch — it crops", () => {
    const issues = validateSlotInputs([slot], { hero: { aspect: 1.0, dpi: 300 } });
    expect(hasBlockingIssues(issues)).toBe(false);
    expect(issues[0].message).toContain("cropped");
  });

  it("tolerates rounding drift from a crop tool", () => {
    expect(validateSlotInputs([slot], { hero: { aspect: 1.51, dpi: 300 } })).toHaveLength(0);
  });
});

describe("validateSlotInputs — unknown inputs", () => {
  const slots: Slot[] = [
    { type: "text", key: "name", label: "Name", required: true, fontRole: "display", fit: "shrink" },
  ];

  it("warns about an input with no slot, which is usually a renamed key", () => {
    const issues = validateSlotInputs(slots, { name: "Ok", titel: "typo" });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("not a slot on this template");
  });

  it("stays quiet about a blank stray input", () => {
    expect(validateSlotInputs(slots, { name: "Ok", stray: "" })).toHaveLength(0);
  });
});

describe("validateSlotInputs — reporting", () => {
  it("returns every issue rather than stopping at the first", () => {
    const slots: Slot[] = [
      { type: "text", key: "a", label: "A", required: true, fontRole: "body", fit: "shrink" },
      { type: "text", key: "b", label: "B", required: true, fontRole: "body", fit: "shrink" },
      { type: "generated", key: "c", label: "C", required: true, generator: "barcode", symbology: "upc-a", magnificationPct: 100 },
    ];
    expect(keys(errors(validateSlotInputs(slots, { c: "111" })))).toEqual(["a", "b", "c"]);
  });
});
