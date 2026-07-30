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
// to `public`. "mission" is kept as a key even though the field it named is
// gone — `visibility` is an exhaustive record, so dropping it here would fail
// validation on every stored document until they're all rewritten. Phase 5
// resolves it.
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

// The Brand Guide's subtabs. Each one opens with an editable introduction
// block (canon.guideIntros) and is the unit the canon editor edits at a time.
export const guideSectionSchema = z.enum([
  "ethos",
  "voice",
  "visual",
  "color",
  "type",
  "marks",
  "agent",
]);

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex color");

// Stable identity for a list item, assigned once by lib/brand/canonIds.ts and
// then never regenerated. Optional because documents written before this field
// existed must still parse; getDraft() backfills them on first read, so a
// stored row acquires ids without a data migration.
//
// diffCanon matches list items across versions by this id. That's what lets the
// auto-generated changelog say "renamed value 3" instead of "values array
// differs", and what stops a reorder being reported as N deletions plus N
// additions. Derive it from nothing — a content-derived id would change when the
// content changes, which defeats the entire purpose.
const idSchema = z.string().optional();

const brandColorSchema = z.object({
  id: idSchema,
  /** Stable slug the roleMap binds to. Not a display name. */
  key: z.string(),
  name: z.string(),
  hex: hexColorSchema,
  /**
   * `core` = a Tier-1 brand color. `neutral` = a UI step.
   *
   * This replaces the old convention of appending "(derived)" to a neutral's
   * NAME, which was misleading — those colors are hand-authored, not computed
   * from anything. Optional so documents written before the split still parse;
   * migration 20260905 sets it on every entry.
   */
  tier: z.enum(["core", "neutral"]).optional(),
  /** What this color is for, in words. Shown prominently in the guide. */
  role: z.string().optional(),
  cmyk: z.string().optional(),
  pms: z.string().optional(),
});

const brandFontSchema = z.object({
  id: idSchema,
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

// One illustrated rule — the shared atom behind Visual Identity's do/don't
// grid and the Color tab's forbidden list, and (later) each mark's usage notes.
// `assetId` points at a brand_assets row of kind `example`.
export const guideRuleSchema = z.object({
  id: idSchema,
  polarity: z.enum(["do", "dont"]),
  title: z.string(),
  detail: z.string().optional(),
  assetId: z.string().optional(),
  caption: z.string().optional(),
});

// Rule lists accept either shape. Documents written before this phase hold bare
// strings, and getCanon() does NOT validate on read — so a schema that rejected
// them would render an empty subtab rather than fail loudly. lib/brand/guideRules
// normalizes on read; migration 20260904 rewrites stored rows to the rich shape.
const ruleListSchema = z.array(z.union([z.string(), guideRuleSchema]));

// A single identity mark (wordmark / logo / chop) and its specification sheet.
// A mark can carry several "cuts"/variants (e.g. the wordmark's horizontal 4A
// and vertical 5E). Optional throughout so a mark can be added with only an
// approved artifact and its spec filled in over time.
const markVariantSchema = z.object({
  id: idSchema,
  code: z.string(), // "Primary · Horizontal · 4A"
  cut: z.string().optional(), // "Descending-J display cut"
  orientation: z.enum(["horizontal", "vertical"]).optional(), // drives the CSS stand-in render
  specs: z.array(keyValSchema),
  /**
   * The artwork files for THIS cut — one variant, many formats (svg + png + pdf).
   *
   * Replaces the guide's three hardcoded `kind`+`variant="default"` lookups,
   * which allowed exactly one file per mark kind and made "add a second
   * wordmark cut" a code change rather than an upload.
   */
  assetIds: z.array(z.string()).optional(),
});

const markSchema = z.object({
  id: idSchema,
  kind: z.enum(["wordmark", "logo", "chop"]),
  title: z.string(),
  status: z.string().optional(), // "Final specification"
  approved: z.string().optional(), // "Approved 22 Jul 2026"
  summary: z.array(z.string()).optional(), // header right-meta lines
  variants: z.array(markVariantSchema),
  colors: z.array(z.object({ name: z.string(), hex: hexColorSchema })).optional(),
  clearspace: z.array(z.string()).optional(),
  oneRule: z.array(z.string()).optional(),
  /** How this mark may and may not be used — the same primitive as the
   *  Visual Identity grid, so a reader meets one pattern across the guide. */
  usage: z.array(guideRuleSchema).optional(),
  note: z.string().optional(), // footer note
});

export const canonSchema = z.object({
  brandName: z.string(),
  version: z.string(),

  // ── Values & their costs (Narrative) ─────────────────────────────────────
  values: z.array(
    z.object({
      id: idSchema,
      n: z.string(),
      title: z.string(),
      means: z.string(),
      cost: z.string(),
    }),
  ),
  neverList: z.array(z.string()),

  // ── Voice (Specification) ────────────────────────────────────────────────
  // The voice's prose lives in guideIntros.voice; what remains here is the
  // calibration a machine can act on.
  voice: z.object({
    sliders: z.array(
      z.object({
        id: idSchema,
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
        id: idSchema,
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
  // Illustrated "never do this" rules. Legacy documents hold bare strings; the
  // Color tab normalizes them to `dont` rules on read.
  colorForbidden: ruleListSchema,

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
  // The illustration narrative lives in guideIntros.visual; the rules stay here.
  // The Visual Identity subtab's rules. Storage key kept as `illustrationLaw`
  // deliberately: renaming it would need the migration to land in lockstep with
  // the deploy, since getCanon() doesn't validate on read and a moved key would
  // render an empty subtab silently. Widening the element type cannot break.
  illustrationLaw: z.object({ rules: ruleListSchema }),

  // ── Rules & precedence ───────────────────────────────────────────────────
  hardRules: z.array(z.string()),
  precedence: z.array(z.string()),

  // ── Brand Guide subtab introductions (Narrative) ─────────────────────────
  // The prose that opens each guide subtab, keyed by subtab — the single home
  // for the guide's narrative copy (what used to be missionNarrative,
  // voice.summary/personality, and illustrationLaw.narrative).
  //
  // Optional and partial so a document written before this field existed still
  // parses; a missing subtab falls back to the seed. Migration
  // 20260818_brand_canon_guide_intros fills it in for the stored rows. See
  // lib/brand/guideIntros.ts — the one place that resolution lives.
  guideIntros: z.partialRecord(guideSectionSchema, z.string()).optional(),

  // ── Public-site visibility per section (Phase 5) ─────────────────────────
  visibility: z.record(sectionKeySchema, z.enum(["internal", "public"])),
});
