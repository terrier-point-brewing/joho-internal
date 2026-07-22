import { getCanon } from "@/lib/brand/getCanon";
import { emitBrandCss, resolveTokens } from "@/lib/brand/tokens";

// Server component: resolves the published brand canon into CSS custom
// properties and injects them as a <style> tag. React 19 hoists <style>
// tags into <head> automatically, so this can render anywhere in the tree
// (see app/layout.tsx — rendered as the first child of <body>).
export default async function BrandStyle() {
  const canon = await getCanon();
  const tokens = resolveTokens(canon);
  const css = emitBrandCss(tokens);

  return <style id="brand-tokens" dangerouslySetInnerHTML={{ __html: css }} />;
}
