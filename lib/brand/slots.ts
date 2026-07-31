import { z } from "zod";

/**
 * A template's slots — the named holes a render fills.
 *
 * A template is a base layout plus these declarations plus the rules on each.
 * Rendering is `template + inputs + active season → artifact`, so a slot is the
 * contract between what an author types and what a renderer is allowed to draw.
 *
 * The types are deliberately few. Every one earns its place by having rules a
 * validator can enforce that the others cannot:
 *
 *   text      — can overflow, so it needs a fit rule
 *   color     — must be a token reference, never a literal (see below)
 *   asset     — must resolve to an approved asset OF A DECLARED KIND
 *   motif     — resolves from the active season, not from author input
 *   image     — commissioned artwork; aspect and resolution are the rules
 *   generated — drawn from a value under a symbology, not placed as art
 *
 * `generated` exists because a barcode is none of the others. It is the only
 * slot whose failure is invisible: a wrong check digit renders a beautiful
 * symbol that no scanner will read, and nobody finds out until the print run
 * is on a shelf. See validateSlots.ts.
 */

export const SLOT_TYPES = [
  "text",
  "color",
  "asset",
  "motif",
  "image",
  "generated",
] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

/** Shared by every slot. `key` is what an input map is keyed on. */
const baseSlot = {
  key: z.string().min(1),
  label: z.string().min(1),
  /** A slot may be declared and left empty; required ones fail validation. */
  required: z.boolean().default(true),
  notes: z.string().optional(),
};

/**
 * What to do when text does not fit its box.
 *
 *   shrink — reduce size down to `minSize`, then fail
 *   wrap   — flow onto more lines, then fail if it runs out of box
 *   reject — never reflow; the author fixes the copy
 */
export const TEXT_FIT = ["shrink", "wrap", "reject"] as const;

const textSlot = z.object({
  ...baseSlot,
  type: z.literal("text"),
  /** Which canon font role sets this text. Bound by role, never by family. */
  fontRole: z.enum(["display", "body", "wordmark", "script"]),
  maxChars: z.number().int().positive().optional(),
  fit: z.enum(TEXT_FIT).default("shrink"),
  /** Floor for `shrink`, in the template's own units. */
  minSize: z.number().positive().optional(),
});

/**
 * A color slot takes a TOKEN REFERENCE — a semantic role name or a palette key —
 * and never a literal.
 *
 * This is the rule that keeps a rendered artifact bound to the canon: a literal
 * hex in an output is frozen at render time and silently diverges the moment the
 * palette moves, which is exactly the drift the canon exists to prevent. The
 * validator rejects anything that looks like a literal, including a hex that
 * happens to match the current token value.
 */
const colorSlot = z.object({
  ...baseSlot,
  type: z.literal("color"),
  /** Restrict the choice — omit to allow any role or palette key. */
  allowed: z.array(z.string()).optional(),
});

const assetSlot = z.object({
  ...baseSlot,
  type: z.literal("asset"),
  /** Only assets of this kind may fill the slot. */
  kind: z.string().min(1),
  variant: z.string().optional(),
});

const motifSlot = z.object({
  ...baseSlot,
  type: z.literal("motif"),
  /**
   * Which part of the season this slot draws. A season resolves to a background
   * color and a chop glyph; a slot names which one it wants.
   */
  resolves: z.enum(["background", "chop-glyph", "season-logo"]),
});

const imageSlot = z.object({
  ...baseSlot,
  type: z.literal("image"),
  /** Width ÷ height. A commissioned piece is drawn to this or it is re-cropped. */
  aspect: z.number().positive().optional(),
  minDpi: z.number().positive().optional(),
});

/**
 * Symbologies this system will draw.
 *
 * UPC-A is the recommendation for cans sold at US retail: it is what US scanners
 * and distributors expect, and Square's catalog already carries the number
 * (`square_catalog_variations.upc`). EAN-13 is the same symbol with one more
 * digit — a UPC-A is an EAN-13 with a leading zero — so supporting both costs
 * almost nothing and leaves international open.
 *
 * A barcode is NOT a legal labeling requirement; it is a retail/GS1 one. The
 * legally mandated elements are different fields entirely.
 */
export const BARCODE_SYMBOLOGIES = ["upc-a", "ean-13"] as const;
export type BarcodeSymbology = (typeof BARCODE_SYMBOLOGIES)[number];

const generatedSlot = z.object({
  ...baseSlot,
  type: z.literal("generated"),
  generator: z.literal("barcode"),
  symbology: z.enum(BARCODE_SYMBOLOGIES),
  /**
   * Magnification against the nominal symbol size, as a percentage. GS1 permits
   * 80–200% for UPC-A/EAN-13; below 80% the bars are too fine for a typical
   * scanner. Held here so the validator can refuse a template that specifies an
   * unscannable size, rather than discovering it after the print run.
   */
  magnificationPct: z.number().min(80).max(200).default(100),
});

export const slotSchema = z.discriminatedUnion("type", [
  textSlot,
  colorSlot,
  assetSlot,
  motifSlot,
  imageSlot,
  generatedSlot,
]);

export type Slot = z.infer<typeof slotSchema>;
export type TextSlot = z.infer<typeof textSlot>;
export type GeneratedSlot = z.infer<typeof generatedSlot>;

export const slotsSchema = z
  .array(slotSchema)
  .refine((slots) => new Set(slots.map((s) => s.key)).size === slots.length, {
    message: "slot keys must be unique within a template",
  });

/**
 * One output size a template can be rendered at.
 *
 * Physical units are first-class because signage and apparel are specified in
 * millimetres and always were — expressing a 2-metre wall graphic in pixels and
 * converting at export is how production scale gets silently lost.
 */
export const renditionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.enum(["px", "mm"]),
  formats: z.array(z.enum(["svg", "png", "pdf"])).min(1),
  /** Raster density for png/pdf output from a mm-specified rendition. */
  dpi: z.number().positive().optional(),
});

export type Rendition = z.infer<typeof renditionSchema>;

export const renditionsSchema = z
  .array(renditionSchema)
  .refine((rs) => new Set(rs.map((r) => r.key)).size === rs.length, {
    message: "rendition keys must be unique within a template",
  });
