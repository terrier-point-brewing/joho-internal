import { describe, expect, it } from "vitest";
import { extractSvgColors, groundForSvg, luminance } from "./svgColor";

describe("extractSvgColors", () => {
  it("reads fill and stroke attributes", () => {
    const svg = '<svg><path fill="#26355D" stroke="#FFFFFF"/></svg>';
    expect(extractSvgColors(svg)).toEqual(["#26355d", "#ffffff"]);
  });

  it("reads colors from inline CSS", () => {
    expect(extractSvgColors('<svg><path style="fill:#ad1a2d"/></svg>')).toEqual(["#ad1a2d"]);
  });

  it("expands three-digit hex", () => {
    expect(extractSvgColors('<svg><path fill="#fff"/></svg>')).toEqual(["#ffffff"]);
  });

  it("resolves the common named colors", () => {
    expect(extractSvgColors('<svg><path fill="white" stroke="black"/></svg>')).toEqual([
      "#ffffff",
      "#000000",
    ]);
  });

  it("skips none, transparent and currentColor", () => {
    // These are the absence of paint — counting them would drag the average
    // toward a ground that doesn't help.
    const svg = '<svg><path fill="none" stroke="transparent"/><path fill="currentColor"/></svg>';
    expect(extractSvgColors(svg)).toEqual([]);
  });

  it("reads gradient stops", () => {
    expect(extractSvgColors('<svg><stop stop-color="#123456"/></svg>')).toEqual(["#123456"]);
  });

  it("returns nothing for an SVG that paints nothing", () => {
    expect(extractSvgColors("<svg><g></g></svg>")).toEqual([]);
  });
});

describe("luminance", () => {
  it("anchors black and white", () => {
    expect(luminance("#000000")).toBeCloseTo(0, 5);
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("groundForSvg", () => {
  it("puts pale artwork on a dark ground", () => {
    // The reported bug: a white mark with no background rendered invisible.
    expect(groundForSvg('<svg><path fill="#ffffff"/></svg>')).toBe("dark");
  });

  it("puts dark artwork on a light ground", () => {
    expect(groundForSvg('<svg><path fill="#26355d"/></svg>')).toBe("light");
  });

  it("leaves multi-tone artwork on the neutral surface", () => {
    // Spans the range, so it carries its own contrast either way.
    expect(groundForSvg('<svg><path fill="#ffffff"/><path fill="#000000"/></svg>')).toBe(
      "neutral",
    );
  });

  it("falls back to neutral when there is nothing to read", () => {
    expect(groundForSvg("<svg></svg>")).toBe("neutral");
    expect(groundForSvg('<svg><path fill="none"/></svg>')).toBe("neutral");
  });

  it("handles a realistic single-colour wordmark", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 80">
      <path fill="#F5F0E6" d="M0 0h40v80H0z"/>
      <path fill="#F5F0E6" d="M60 0h40v80H60z"/>
    </svg>`;
    expect(groundForSvg(svg)).toBe("dark");
  });
});
