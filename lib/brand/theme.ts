export const THEME_COOKIE = "brand-theme";

export type ThemeChoice = "light" | "dark" | "system";

// Resolve a raw cookie value into a `data-theme` attribute value. "light"/"dark"
// pass through; anything else (including "system", undefined, or garbage)
// resolves to null, meaning: no `data-theme` attr — let
// `prefers-color-scheme` decide.
export function resolveThemeAttr(choice: string | undefined): "light" | "dark" | null {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return null;
}
