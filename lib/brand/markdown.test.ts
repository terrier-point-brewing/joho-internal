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
      palette: [{ key: "k", name: "Test Ink", hex: "#123456", cmyk: "1 2 3 4" }],
    }).full;

    expect(full).toContain("#123456");
    expect(full).toContain("CMYK 1 2 3 4");
  });

  // Pantone left the canon (migration 20260907100000). Archived rows still hold
  // a `pms` key and getCanon() does not validate on read, so a stale document
  // reaches the compiler intact — it must be ignored, not printed.
  it("ignores a leftover Pantone code on an archived document", () => {
    const full = compile({
      palette: [
        { key: "k", name: "Test Ink", hex: "#123456", cmyk: "1 2 3 4", pms: "123 C" },
      ] as unknown as BrandCanon["palette"],
    }).full;

    expect(full).toContain("CMYK 1 2 3 4");
    expect(full).not.toContain("123 C");
    expect(full).not.toContain("PMS");
  });

  // Phase A. Before it, `naming`, `labelChassis` and `chop` reached this brief
  // nowhere — an agent asked to lay out a label or propose a name got the
  // never-words and nothing else. These are the regression guards for that.
  describe("the specs Phase A brought into the brief", () => {
    it("states the naming pattern and all five criteria", () => {
      const full = compile({
        naming: {
          pattern: "Story Title — Plain Style Subtitle",
          narrative: "A name earns its place.",
          criteria: ["Grounded in a real story", "Speakable", "Plain subtitle", "No never-words", "Said aloud"],
          passingExamples: [
            {
              name: "Peach Blossom Spring",
              story: "A fisherman follows the blossoms upstream.",
              menuDescription: "Soft, floral, gently sweet.",
              why: "Grounded in place",
            },
          ],
        },
      }).full;

      expect(full).toContain("Story Title — Plain Style Subtitle");
      expect(full).toContain("1. Grounded in a real story");
      expect(full).toContain("5. Said aloud");
      expect(full).toContain("Peach Blossom Spring — Grounded in place");
      // An agent proposing a name needs the two pieces of writing that produce
      // the verdict, not just the verdict.
      expect(full).toContain("Story: A fisherman follows the blossoms upstream.");
      expect(full).toContain("Menu: Soft, floral, gently sweet.");
    });

    it("states the label chassis, numbered in panel order", () => {
      const full = compile({
        labelChassis: {
          narrative: "The illustration roams; the chassis is home.",
          elements: [
            { n: "1", title: "Wordmark", desc: "Top band. Never re-typeset." },
            { n: "4", title: "The chop", desc: "Bottom-right of the art window." },
          ],
        },
      }).full;

      expect(full).toContain("### Label chassis");
      expect(full).toContain("The illustration roams; the chassis is home.");
      expect(full).toContain("- 1. Wordmark: Top band. Never re-typeset.");
      expect(full).toContain("- 4. The chop: Bottom-right of the art window.");
    });

    it("states the chop's placement spec", () => {
      const full = compile({
        chop: {
          narrative: "The brand's second signature.",
          specs: [{ key: "Footprint", value: "Square, 8–10% of art-window height" }],
        },
      }).full;

      expect(full).toContain("### The chop");
      expect(full).toContain("- Footprint: Square, 8–10% of art-window height");
    });

    it("states clearspace in enforceable form when a mark carries it", () => {
      const full = compile({
        marks: [
          {
            kind: "wordmark",
            title: "JOHO",
            variants: [{ code: "Horizontal", specs: [] }],
            clearspaceSpec: [{ unit: "cap-height", value: 1, note: "the O" }],
          },
        ],
      }).full;

      expect(full).toContain("Clearspace: 1 cap-height on all sides — the O");
    });
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
