import { getBrandChromeEnabled } from "@/lib/settings/brandChrome.server";
import { getCanon } from "@/lib/brand/getCanon";
import { resolveTokens } from "@/lib/brand/tokens";
import { opsChromeOverrideCss } from "@/lib/brand/opsThemeMap";

// When the "apply brand to app" toggle is on, override the ops --color-* tokens
// with the brand palette (light + dark) so the whole internal UI wears Joho and
// flips light/dark via the same `data-theme` mechanism as the brand surfaces.
// Renders nothing when off — the default zinc/amber globals apply (fallback).
// The override reads the published canon, so editing the brand Theme facet +
// publishing re-skins the app too.
export default async function BrandChrome() {
  const enabled = await getBrandChromeEnabled();
  if (!enabled) return null;

  const tokens = resolveTokens(await getCanon());
  return (
    <style
      id="brand-chrome"
      dangerouslySetInnerHTML={{ __html: opsChromeOverrideCss(tokens.light, tokens.dark) }}
    />
  );
}
