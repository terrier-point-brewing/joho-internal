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
  "release",
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
  /**
   * Process CMYK, "C M Y K" as percentages. Derived from `hex` by
   * lib/brand/cmyk.ts unless authored; migration 20260907100000 backfilled
   * every color. Not a color-managed separation — see that module.
   *
   * There is deliberately no `pms`. Pantone was populated on the four Tier-1
   * colors and nowhere else, with no derivable source for the rest, so it was
   * removed rather than left half-filled on a guide people copy values out of.
   * Spot matching is a prepress conversation from the hex and this value.
   */
  cmyk: z.string().optional(),
});

const brandFontSchema = z.object({
  id: idSchema,
  role: fontRoleSchema,
  family: z.string(),
  cssStack: z.string(),
  weights: z.array(z.number()),
  /**
   * Where the face comes from. Absent on documents predating the split;
   * lib/brand/fontRegistry.ts infers it from the family in that case.
   *
   *   bundled  — loaded by next/font in app/layout.tsx
   *   uploaded — a brand_assets row of kind `font`, served via @font-face
   *   system   — a stack of families already on the device
   */
  source: z.enum(["bundled", "uploaded", "system"]).optional(),
  /** Font files for an `uploaded` face — woff2/woff/ttf/otf. */
  assetIds: z.array(z.string()).optional(),
  /** Licensing note. Uploaded faces are redistributed by this app. */
  license: z.string().optional(),
  /**
   * Cap height as a fraction of the em — Marcellus ≈ 0.7, Lato ≈ 0.72.
   *
   * Needed to place type by its cap height rather than its font size. A slot
   * that says "26mm cap height" (the wordmark's stated minimum) cannot be
   * rendered from a font size alone, and optical spacing between a title and a
   * rule is measured from the cap line, not the em box. Measured per face, so
   * it is authored rather than derived.
   */
  capHeightRatio: z.number().positive().max(2).optional(),
  note: z.string().optional(),
});

/**
 * One machine-readable clearspace rule.
 *
 * The prose `clearspace` lines stay as the human statement; this is the same
 * rule in a form a renderer can enforce. "Clearspace = cap height of the O on
 * all sides" becomes { unit: 'cap-height', value: 1 }.
 */
const clearspaceRuleSchema = z.object({
  id: idSchema,
  unit: z.enum(["cap-height", "mm", "px", "percent"]),
  value: z.number(),
  /** Which edges it applies to. Omitted means all four. */
  sides: z.array(z.enum(["top", "right", "bottom", "left"])).optional(),
  note: z.string().optional(),
});

/**
 * One typographic use case — "page title on screen", "poster title in print".
 *
 * The guide previously described type as one run-on line per role
 * (`display · Marcellus · weights 400 · <note>`), which said nothing about
 * where a face is used or at what size. These rows render a live specimen at
 * their own stated size and weight, so "48pt poster title" is something you
 * see rather than a claim you take on trust.
 */
const typeUseCaseSchema = z.object({
  id: idSchema,
  medium: z.enum(["screen", "print", "packaging", "signage"]),
  element: z.string(),
  fontRole: fontRoleSchema,
  weight: z.number(),
  /** As authored — "32/38", "48pt". Free text: print and screen don't share units. */
  size: z.string(),
  tracking: z.string().optional(),
  notes: z.string().optional(),
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

// One side of a paired rule. A panel is what the rule looks like when it is
// obeyed (or broken): a one-line caption, and the artwork that shows it.
//
// `brief` is the art direction — what the illustration must depict. It is
// authored BEFORE the illustration exists (none are commissioned yet), so it
// doubles as the line in the empty image slot and as the alt text until an
// uploaded asset carries its own.
const rulePanelSchema = z.object({
  caption: z.string().optional(),
  brief: z.string().optional(),
  assetId: z.string().optional(),
});

// Visual Identity's rules are PAIRS, not two independent columns.
//
// Every rule the founder wrote has the same shape: here is the thing to do,
// here is the specific failure it exists to prevent. Storing that as one row
// with two sides makes the relationship the data — a reader sees "flat vector"
// opposite "photorealism" instead of having to find the matching prohibition
// three bullets down a separate list. `nuance` is why the rule exists, which is
// the half a bare do/don't always loses.
export const rulePairSchema = z.object({
  id: idSchema,
  title: z.string(),
  do: rulePanelSchema,
  dont: rulePanelSchema,
  nuance: z.string().optional(),
});

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
  /** The human statement of clearspace, one rule per line. */
  clearspace: z.array(z.string()).optional(),
  /** The same rules in enforceable form. Optional: prose came first and stays. */
  clearspaceSpec: z.array(clearspaceRuleSchema).optional(),
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
    // There is no `pattern` string. It said "Story Title — Beer Style", which
    // is the shape of an example's own two fields — migration 20260912100000
    // split `name` into `storyTitle` and `beerStyle` and dropped the pattern,
    // so the rule is now carried by the slots a writer types into rather than
    // by a sentence above them repeating what those slots already are.
    //
    // The narrative is a TEMPLATE, not a paragraph: the same four slots a
    // passing example fills, holding the instruction for each instead of the
    // content. It was one long string until migration 20260912090000, which
    // read as a wall of prose above four example cards that already carried
    // those exact labels — the guide was explaining a card's fields somewhere
    // other than on a card. Same keys as `passingExamples` so the Voice tab
    // renders both through one component.
    narrative: z.object({
      /** One line above the template card, framing what the slots are for. */
      intro: z.string(),
      name: z.string(),
      story: z.string(),
      menuDescription: z.string(),
      why: z.string(),
      /** The read-it-aloud test, set apart at the foot of the card. */
      footer: z.string(),
    }),
    criteria: z.array(z.string()).length(5),
    // Five required fields because the guide renders five lines per example —
    // the two halves of the name, then the three lines under it.
    // Optional keys would let a half-filled example publish and sit on the
    // brand guide as a card with one line beside a card with three — and the
    // published 1.7 document shows what happens without the slots: its first
    // example had a story line ("In Pingxi, they say a wish doesn't count
    // until you lose sight of it") stuffed into `why`, because there was
    // nowhere else to put it. Migration 20260910090000 backfills every row.
    //
    // Required, but not `.min(1)`: nothing in this schema forbids the empty
    // string, and saveDraftSection parses on every tab save, so a length gate
    // would block saving a half-written example mid-edit. Emptiness is the
    // draft's business; the shape is the schema's.
    passingExamples: z.array(
      z.object({
        storyTitle: z.string(),
        beerStyle: z.string(),
        story: z.string(),
        menuDescription: z.string(),
        why: z.string(),
      }),
    ),
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

  // Where each face is actually used, grouped by medium in the guide.
  // Optional: documents predating this field simply show no use-case table.
  typeUseCases: z.array(typeUseCaseSchema).optional(),

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
  illustrationLaw: z.object({
    pairs: z.array(rulePairSchema).optional(),
    /**
     * The pre-pairing shape: one flat list of rules, each carrying a polarity.
     * Kept optional and still accepted because every archived version holds it,
     * and because a draft written before the pairing must still validate at
     * publish. lib/brand/rulePairs.ts folds it into pairs on read, so nothing
     * downstream has two shapes to think about.
     */
    rules: ruleListSchema.optional(),
    /**
     * Permission, not a rule — so it sits beneath the introduction rather than
     * in the card set, where it was the one entry with no failure opposite it.
     */
    homage: z.string().optional(),
  }),

  // ── Rules & precedence ───────────────────────────────────────────────────
  hardRules: z.array(z.string()),
  precedence: z.array(z.string()),

  /**
   * Rules that apply ONLY to agents building on the brand, and to nothing a
   * human reads elsewhere in the guide — token binding, asset handling, what
   * to do when the canon is ambiguous.
   *
   * Everything else in the Agent Rules markdown is compiled from the other
   * subtabs, so this is the one place agent-specific technical direction lives.
   */
  agentTechnical: z.array(z.string()).optional(),

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
