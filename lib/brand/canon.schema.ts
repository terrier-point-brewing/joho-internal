import { z } from "zod";

// Single source of truth for the canon shape: canon.types.ts's BrandCanon =
// z.infer<typeof canonSchema>. The canon carries both a Narrative layer (the
// why — mission narrative, values, voice, the chop/chassis/illustration
// stories) and a Specification layer (the what — palette, roleMap, fonts,
// rules), mirroring the founder-approved brand guide. Every section is a
// permanent, editable slot; content evolves via the canon editor over time.

const roleNameSchema = z.enum([
  "canvas",
  "surface",
  "surface-raised",
  "primary",
  "on-primary",
  "secondary",
  "accent",
  "on-accent",
  "high-contrast",
  "content",
  "content-muted",
  "line",
  "line-strong",
]);

const fontRoleSchema = z.enum(["display", "body", "wordmark", "script"]);

// Sections that carry a visibility flag for the eventual public site (Phase 5):
// the internal (auth-gated) guide shows everything; a public renderer filters
// to `public`.
const sectionKeySchema = z.enum([
  "mission",
  "values",
  "neverList",
  "voice",
  "naming",
  "color",
  "typography",
  "chop",
  "labelChassis",
  "illustrationLaw",
  "hardRules",
  "precedence",
]);

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex color");

const brandColorSchema = z.object({
  key: z.string(),
  name: z.string(),
  hex: hexColorSchema,
  role: z.string().optional(),
  cmyk: z.string().optional(),
  pms: z.string().optional(),
});

const brandFontSchema = z.object({
  role: fontRoleSchema,
  family: z.string(),
  cssStack: z.string(),
  weights: z.array(z.number()),
  note: z.string().optional(),
});

const roleMapSchema = z.object({
  light: z.record(roleNameSchema, z.string()),
  dark: z.partialRecord(roleNameSchema, z.string()),
});

const keyValSchema = z.object({ key: z.string(), value: z.string() });

// A single identity mark (wordmark / logo / chop) and its specification sheet.
// A mark can carry several "cuts"/variants (e.g. the wordmark's horizontal 4A
// and vertical 5E). Optional throughout so a mark can be added with only an
// approved artifact and its spec filled in over time.
const markVariantSchema = z.object({
  code: z.string(), // "Primary · Horizontal · 4A"
  cut: z.string().optional(), // "Descending-J display cut"
  orientation: z.enum(["horizontal", "vertical"]).optional(), // drives the CSS stand-in render
  specs: z.array(keyValSchema),
});

const markSchema = z.object({
  kind: z.enum(["wordmark", "logo", "chop"]),
  title: z.string(),
  status: z.string().optional(), // "Final specification"
  approved: z.string().optional(), // "Approved 22 Jul 2026"
  summary: z.array(z.string()).optional(), // header right-meta lines
  variants: z.array(markVariantSchema),
  colors: z.array(z.object({ name: z.string(), hex: hexColorSchema })).optional(),
  clearspace: z.array(z.string()).optional(),
  oneRule: z.array(z.string()).optional(),
  note: z.string().optional(), // footer note
});

export const canonSchema = z.object({
  brandName: z.string(),
  version: z.string(),

  // ── Mission (Narrative) ──────────────────────────────────────────────────
  mission: z.string(),
  missionNarrative: z.string(),

  // ── Values & their costs (Narrative) ─────────────────────────────────────
  values: z.array(
    z.object({
      n: z.string(),
      title: z.string(),
      means: z.string(),
      cost: z.string(),
    }),
  ),
  neverList: z.array(z.string()),

  // ── Voice (Narrative + Specification) ────────────────────────────────────
  voice: z.object({
    summary: z.string(),
    personality: z.string(),
    sliders: z.array(
      z.object({
        left: z.string(),
        right: z.string(),
        pos: z.number(), // 0–100 toward `right`
        note: z.string(),
      }),
    ),
    neverWords: z.array(z.string()),
    leanOnWords: z.array(z.string()),
    rewrites: z.array(
      z.object({
        context: z.string(),
        on: z.string(),
        off: z.string(),
      }),
    ),
  }),

  // ── Naming (Specification) ───────────────────────────────────────────────
  naming: z.object({
    pattern: z.string(),
    narrative: z.string(),
    criteria: z.array(z.string()).length(5),
    passingExamples: z.array(z.object({ name: z.string(), why: z.string() })),
  }),

  // ── Color (Specification) ────────────────────────────────────────────────
  palette: z.array(brandColorSchema),
  roleMap: roleMapSchema,
  usageRatios: z.array(
    z.object({ role: roleNameSchema, pct: z.number(), note: z.string().optional() }),
  ),
  colorForbidden: z.array(z.string()),

  // ── Typography (Specification) ───────────────────────────────────────────
  fonts: z
    .array(brandFontSchema)
    .refine((fonts) => new Set(fonts.map((f) => f.role)).size === fonts.length, {
      message: "fonts must have at most one entry per role",
    }),

  // ── Marks (Specification) — wordmark / logo / chop spec sheets ────────────
  // Optional: published rows written before this field existed simply have no
  // marks, and the guide's Marks tab falls back to showing approved artifacts
  // alone (see app/brand/guide/MarksView.tsx).
  marks: z.array(markSchema).optional(),

  // ── The chop / label chassis / illustration (Specification + Narrative) ──
  chop: z.object({ narrative: z.string(), specs: z.array(keyValSchema) }),
  labelChassis: z.object({
    narrative: z.string(),
    elements: z.array(z.object({ n: z.string(), title: z.string(), desc: z.string() })),
  }),
  illustrationLaw: z.object({ narrative: z.string(), rules: z.array(z.string()) }),

  // ── Rules & precedence ───────────────────────────────────────────────────
  hardRules: z.array(z.string()),
  precedence: z.array(z.string()),

  // ── Public-site visibility per section (Phase 5) ─────────────────────────
  visibility: z.record(sectionKeySchema, z.enum(["internal", "public"])),
});
