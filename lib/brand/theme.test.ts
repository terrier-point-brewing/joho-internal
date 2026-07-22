import { describe, expect, it } from "vitest";
import { resolveThemeAttr, THEME_COOKIE } from "./theme";

describe("THEME_COOKIE", () => {
  it("is the expected cookie name", () => {
    expect(THEME_COOKIE).toBe("brand-theme");
  });
});

describe("resolveThemeAttr", () => {
  it("maps 'light' to 'light'", () => {
    expect(resolveThemeAttr("light")).toBe("light");
  });

  it("maps 'dark' to 'dark'", () => {
    expect(resolveThemeAttr("dark")).toBe("dark");
  });

  it("maps 'system' to null", () => {
    expect(resolveThemeAttr("system")).toBeNull();
  });

  it("maps undefined to null", () => {
    expect(resolveThemeAttr(undefined)).toBeNull();
  });

  it("maps an unrecognized value to null", () => {
    expect(resolveThemeAttr("bogus")).toBeNull();
  });
});
