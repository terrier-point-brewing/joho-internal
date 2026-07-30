import { describe, expect, it } from "vitest";
import { suggestDarkRoles } from "./suggestDark";
import { resolveDarkRoles, resolveLightRoles, ROLE_NAMES } from "./tokens";
import { deriveDarkPalette } from "./deriveDark";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

describe("suggestDarkRoles", () => {
  it("covers every role exactly once, in role order", () => {
    const out = suggestDarkRoles(seedCanon);
    expect(out.map((s) => s.role)).toEqual(ROLE_NAMES);
  });

  it("snaps a role whose derived color already exists in the palette", () => {
    // `secondary` uses the `keep` treatment, so its derived dark value IS the
    // light one — an exact palette match.
    const secondary = suggestDarkRoles(seedCanon).find((s) => s.role === "secondary")!;
    expect(secondary.verdict).toBe("snap");
    expect(secondary.nearestKey).toBe("camphor");
    expect(secondary.distance).toBeCloseTo(0, 5);
  });

  it("says `add` when nothing in the palette is close", () => {
    const accent = suggestDarkRoles(seedCanon).find((s) => s.role === "accent")!;
    // A brightened Seal Red has no counterpart in the 8-color seed palette.
    expect(accent.verdict).toBe("add");
    expect(accent.reason).toBe("no-close-match");
  });

  it("still reports the nearest key on an `add`, so the editor can explain itself", () => {
    // "Nearest is Seal Red at ΔE 0.15, too far" is actionable; a bare "add" is not.
    const accent = suggestDarkRoles(seedCanon).find((s) => s.role === "accent")!;
    expect(accent.nearestKey).toBeTruthy();
    expect(accent.distance).toBeGreaterThan(0);
  });

  it("distinguishes a collision from a plain distance miss", () => {
    const out = suggestDarkRoles(seedCanon);
    const collided = out.filter((s) => s.reason === "would-collide");
    for (const s of collided) {
      expect(s.verdict).toBe("add");
      // A collision means it DID have a close match — that's what collided.
      expect(s.nearestKey).toBeTruthy();
    }
  });

  it("never snaps two distinct-pair roles to the same palette key", () => {
    const out = suggestDarkRoles(seedCanon);
    const keyFor = (role: string) => out.find((s) => s.role === role)!;

    for (const [a, b] of [
      ["canvas", "surface"],
      ["surface", "surface-raised"],
      ["surface-raised", "line-strong"],
    ]) {
      const first = keyFor(a);
      const second = keyFor(b);
      const collided =
        first.verdict === "snap" && second.verdict === "snap" && first.nearestKey === second.nearestKey;
      expect(collided, `${a} and ${b} both snapped to ${first.nearestKey}`).toBe(false);
    }
  });

  it("keeps the closer match when a collision is broken", () => {
    const out = suggestDarkRoles(seedCanon);
    const surface = out.find((s) => s.role === "surface")!;
    const raised = out.find((s) => s.role === "surface-raised")!;
    // Whichever gave way must be the one that matched less closely.
    if (surface.verdict === "add" || raised.verdict === "add") {
      const gaveWay = surface.verdict === "add" ? surface : raised;
      const kept = surface.verdict === "add" ? raised : surface;
      expect(gaveWay.distance).toBeGreaterThanOrEqual(kept.distance);
    }
  });

  it("always reports the derived hex, even when it says add", () => {
    for (const s of suggestDarkRoles(seedCanon)) {
      expect(s.derived).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("resolveDarkRoles", () => {
  it("matches the old derived output when the dark map is empty", () => {
    // The safety net: shipping the symmetric model before migration 20260905
    // must not change a single rendered color.
    const light = resolveLightRoles(seedCanon);
    expect(resolveDarkRoles(seedCanon, light)).toEqual(deriveDarkPalette(light));
  });

  it("resolves a palette key to its hex", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, dark: { canvas: "indigo" } },
    };
    const light = resolveLightRoles(canon);
    expect(resolveDarkRoles(canon, light).canvas).toBe("#26355d");
  });

  it("still honours a raw hex override", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, dark: { canvas: "#010203" } },
    };
    const light = resolveLightRoles(canon);
    expect(resolveDarkRoles(canon, light).canvas).toBe("#010203");
  });

  it("falls back per-role, not all-or-nothing", () => {
    const canon: BrandCanon = {
      ...seedCanon,
      roleMap: { ...seedCanon.roleMap, dark: { canvas: "indigo" } },
    };
    const light = resolveLightRoles(canon);
    const derived = deriveDarkPalette(light);
    const resolved = resolveDarkRoles(canon, light);

    expect(resolved.canvas).toBe("#26355d");
    expect(resolved.accent).toBe(derived.accent);
  });
});
