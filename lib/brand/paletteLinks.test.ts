import { describe, expect, it } from "vitest";
import { isPaletteKey, resolveRole, rolesByPaletteKey } from "./paletteLinks";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

describe("rolesByPaletteKey", () => {
  it("lists every role a palette key drives", () => {
    const map = rolesByPaletteKey(seedCanon, "light");
    // Indigo drives both primary and high-contrast in the seed.
    expect(map.get("indigo")?.sort()).toEqual(["high-contrast", "primary"]);
  });

  it("indexes a key that drives exactly one role", () => {
    expect(rolesByPaletteKey(seedCanon, "light").get("seal-red")).toEqual(["accent"]);
  });

  it("omits a key no role binds to", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      palette: [...seedCanon.palette, { key: "unused", name: "Unused", hex: "#123456" }],
    };
    expect(rolesByPaletteKey(canon, "light").get("unused")).toBeUndefined();
  });

  it("does not index a detached raw-hex role", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, light: { ...seedCanon.roleMap.light, accent: "#ff0000" } },
    };
    const map = rolesByPaletteKey(canon, "light");
    expect(map.get("#ff0000")).toBeUndefined();
    expect([...map.values()].flat()).not.toContain("accent");
  });

  it("returns an empty index for a dark map that has not been populated", () => {
    expect(rolesByPaletteKey(seedCanon, "dark").size).toBe(0);
  });
});

describe("isPaletteKey", () => {
  it("recognises a real key", () => {
    expect(isPaletteKey("indigo", seedCanon)).toBe(true);
  });

  it("rejects a raw hex", () => {
    expect(isPaletteKey("#26355d", seedCanon)).toBe(false);
  });
});

describe("resolveRole", () => {
  it("resolves a linked role to its palette color", () => {
    expect(resolveRole(seedCanon, "light", "primary")).toEqual({
      hex: "#26355d",
      key: "indigo",
      detached: false,
    });
  });

  it("flags a detached role and still returns its hex", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, light: { ...seedCanon.roleMap.light, accent: "#ff0000" } },
    };
    expect(resolveRole(canon, "light", "accent")).toEqual({
      hex: "#ff0000",
      key: null,
      detached: true,
    });
  });

  it("returns null for a role the map omits", () => {
    expect(resolveRole(seedCanon, "dark", "canvas")).toBeNull();
  });
});
