import type { z } from "zod";
import type { canonSchema } from "./canon.schema";

export type RoleName =
  | "canvas"
  | "surface"
  | "surface-raised"
  | "primary"
  | "on-primary"
  | "secondary"
  | "accent"
  | "on-accent"
  | "high-contrast"
  | "content"
  | "content-muted"
  | "line"
  | "line-strong";

export type FontRole = "display" | "body" | "wordmark" | "script";

// The canon document shape (write-validation contract lives in
// canon.schema.ts; this type is inferred from that schema so the two never
// drift apart).
export type BrandCanon = z.infer<typeof canonSchema>;

export interface ResolvedTokens {
  light: Record<RoleName, string>; // role → hex
  dark: Record<RoleName, string>; // role → hex (derived ?? override)
  fonts: Record<FontRole, string>; // role → cssStack
}
