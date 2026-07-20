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

export interface BrandColor {
  key: string;
  name: string;
  hex: string;
  cmyk?: string;
  pms?: string;
}

export interface BrandFont {
  role: FontRole;
  family: string;
  cssStack: string;
  weights: number[];
  note?: string;
}

export interface RoleMap {
  // each role → a brand color `key` (from palette) OR a raw hex
  light: Record<RoleName, string>;
  // sparse overrides applied over the derived dark palette (role → hex)
  dark: Partial<Record<RoleName, string>>;
}

export interface BrandCanon {
  brandName: string; // "Joho"  (data only — never referenced by token names)
  version: string; // "1.0"
  mission: string;
  palette: BrandColor[]; // Paper / Indigo / Seal Red / Camphor Tan (+ neutrals)
  roleMap: RoleMap;
  usageRatios: { role: RoleName; pct: number; note?: string }[]; // Paper 60 / Indigo 30 / accent 10
  fonts: BrandFont[];
  voice: {
    summary: string;
    sliders: { label: string; left: string; right: string; note: string }[];
    neverWords: string[];
    leanOnWords: string[];
  };
  naming: {
    pattern: string;
    criteria: string[];
    passingExamples?: { name: string; why: string }[];
  };
  precedence: string[]; // ordered precedence chain (§10)
  agentRules: string[]; // the top-10 hard rules (§8)
}

export interface ResolvedTokens {
  light: Record<RoleName, string>; // role → hex
  dark: Record<RoleName, string>; // role → hex (derived ?? override)
  fonts: Record<FontRole, string>; // role → cssStack
}
