import { describe, expect, it } from "vitest";
import { compileBrandMarkdown } from "./markdown";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

const compile = (over: Partial<BrandCanon> = {}) =>
  compileBrandMarkdown({ ...seedCanon, ...over });

describe("compileBrandMarkdown", () => {
  it("opens with the brand name", () => {
    expect(compile().full.startsWith(`# ${seedCanon.brandName}`)).toBe(true);
  });

  it("emits a section per populated subtab", () => {
    const keys = compile().sections.map((s) => s.key);
    expect(keys).toContain("ethos");
    expect(keys).toContain("voice");
    expect(keys).toContain("color");
    expect(keys).toContain("type");
  });

  it("gives every section a level-2 heading", () => {
    for (const section of compile().sections) {
      expect(section.markdown.startsWith(`## ${section.heading}`)).toBe(true);
    }
  });

  it("concatenates every section into `full`", () => {
    const { sections, full } = compile();
    for (const section of sections) expect(full).toContain(section.markdown);
  });

  it("omits a section that would be nothing but its heading", () => {
    // An agent reading a bare heading learns nothing.
    const keys = compile({ agentTechnical: [] }).sections.map((s) => s.key);
    expect(keys).not.toContain("technical");
  });

  it("includes agent-only technical rules when present", () => {
    const { sections, full } = compile({
      agentTechnical: ["Bind to role tokens, never to colour names."],
    });
    expect(sections.map((s) => s.key)).toContain("technical");
    expect(full).toContain("Bind to role tokens, never to colour names.");
  });

  it("states rule polarity explicitly", () => {
    // "flat line work" and "never flat line work" are the same words either
    // side of a prefix, and the markdown is all an agent reads.
    const full = compile({
      illustrationLaw: {
        rules: [
          { id: "a", polarity: "do", title: "Flat line work" },
          { id: "b", polarity: "dont", title: "Drop shadows" },
        ],
      },
    }).full;

    expect(full).toContain("ALWAYS: Flat line work");
    expect(full).toContain("NEVER: Drop shadows");
  });

  it("never renders an object as [object Object]", () => {
    expect(compile().full).not.toContain("[object Object]");
  });

  it("still renders legacy string rules", () => {
    const full = compile({
      colorForbidden: ["Pure black anywhere."],
      illustrationLaw: { rules: ["Flat two-colour line work."] },
    }).full;

    expect(full).toContain("Pure black anywhere.");
    expect(full).toContain("Flat two-colour line work.");
  });

  it("lists role bindings, which are what an agent actually uses", () => {
    const full = compile().full;
    expect(full).toContain("Bind to these, never to a color name.");
    expect(full).toContain("- primary: light `indigo`");
  });

  it("carries every palette code it has", () => {
    const full = compile({
      palette: [{ key: "k", name: "Test Ink", hex: "#123456", cmyk: "1 2 3 4", pms: "123 C" }],
    }).full;

    expect(full).toContain("#123456");
    expect(full).toContain("CMYK 1 2 3 4");
    expect(full).toContain("PMS 123 C");
  });

  it("numbers precedence, since the order is the meaning", () => {
    const full = compile({ precedence: ["Safety", "Legal", "Brand"] }).full;
    expect(full).toContain("1. Safety");
    expect(full).toContain("3. Brand");
  });

  it("marks the never-words as an absolute", () => {
    expect(compile().full).toContain("NEVER use:");
  });

  it("is deterministic", () => {
    expect(compile().full).toBe(compile().full);
  });

  it("survives a canon with empty optional collections", () => {
    expect(() =>
      compile({ marks: [], typeUseCases: [], colorForbidden: [], values: [] }),
    ).not.toThrow();
  });

  it("closes with the escalation instruction", () => {
    expect(compile().full.trimEnd().endsWith("escalate to the founder.")).toBe(true);
  });
});

describe("compileBrandMarkdown formatting", () => {
  it("never emits three or more consecutive newlines", () => {
    // Blocks are joined with one blank line; carrying their own trailing
    // padding as well produced a gappy document.
    expect(compile().full).not.toMatch(/\n{3,}/);
  });

  it("separates the title from the following line by exactly one blank line", () => {
    const [title, blank, next] = compile().full.split("\n");
    expect(title.startsWith("# ")).toBe(true);
    expect(blank).toBe("");
    expect(next.length).toBeGreaterThan(0);
  });
});
