import { describe, expect, it } from "vitest";
import { cssSize } from "./typeSpecimen";

describe("cssSize", () => {
  it("reads a size/leading pair as its leading number in px", () => {
    expect(cssSize("32/38")).toBe("32px");
  });

  it("reads an explicit unit", () => {
    expect(cssSize("48pt")).toBe("48pt");
    expect(cssSize("1.5rem")).toBe("1.5rem");
  });

  it("tolerates a space before the unit", () => {
    expect(cssSize("24 px")).toBe("24px");
  });

  it("defaults a bare number to px", () => {
    expect(cssSize("16")).toBe("16px");
  });

  it("rejects a value large enough to break the page", () => {
    // This lands in an inline style from an admin-entered field. A fat-fingered
    // "3200" must not render a word across the whole viewport.
    expect(cssSize("3200")).toBeUndefined();
    expect(cssSize("500pt")).toBeUndefined();
    expect(cssSize("40rem")).toBeUndefined();
  });

  it("rejects zero and negatives", () => {
    expect(cssSize("0")).toBeUndefined();
    expect(cssSize("-12px")).toBeUndefined();
  });

  it("returns nothing for text it cannot read", () => {
    expect(cssSize("")).toBeUndefined();
    expect(cssSize("large")).toBeUndefined();
    expect(cssSize("auto")).toBeUndefined();
  });

  it("is case-insensitive about units", () => {
    expect(cssSize("48PT")).toBe("48pt");
  });
});
