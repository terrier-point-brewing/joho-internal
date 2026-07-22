import { z } from "zod";

// Mirrors lib/brand/canon.types.ts's hand-written shape (pre-Task-1). This is
// now the single source of truth: canon.types.ts's BrandCanon = z.infer<typeof
// canonSchema>. Keep in sync with RoleName/FontRole if those unions change.

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

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex color");

const brandColorSchema = z.object({
  key: z.string(),
  name: z.string(),
  hex: hexColorSchema,
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
  // every role must be mapped for light
  light: z.record(roleNameSchema, z.string()),
  // sparse overrides for dark
  dark: z.partialRecord(roleNameSchema, z.string()),
});

export const canonSchema = z.object({
  brandName: z.string(),
  version: z.string(),
  mission: z.string(),
  palette: z.array(brandColorSchema),
  roleMap: roleMapSchema,
  usageRatios: z.array(
    z.object({
      role: roleNameSchema,
      pct: z.number(),
      note: z.string().optional(),
    }),
  ),
  fonts: z
    .array(brandFontSchema)
    .refine(
      (fonts) => {
        const roles = fonts.map((f) => f.role);
        return new Set(roles).size === roles.length;
      },
      { message: "fonts must have at most one entry per role" },
    ),
  voice: z.object({
    summary: z.string(),
    sliders: z.array(
      z.object({
        label: z.string(),
        left: z.string(),
        right: z.string(),
        note: z.string(),
      }),
    ),
    neverWords: z.array(z.string()),
    leanOnWords: z.array(z.string()),
  }),
  naming: z.object({
    pattern: z.string(),
    criteria: z.array(z.string()).length(5),
    passingExamples: z
      .array(
        z.object({
          name: z.string(),
          why: z.string(),
        }),
      )
      .optional(),
  }),
  precedence: z.array(z.string()),
  agentRules: z.array(z.string()),
});
