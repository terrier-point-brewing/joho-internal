import { getCanon } from "@/lib/brand/getCanon";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assetFileUrl, listAssets, type SupabaseLikeClient } from "@/lib/brand/assets";
import { safeFamilyName, sourceOf } from "@/lib/brand/fontRegistry";

/** Storage format → the `format()` hint a browser needs in an @font-face src. */
const FORMAT_HINT: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

/**
 * Declares `@font-face` for every uploaded brand typeface.
 *
 * Sibling of BrandStyle: that one emits the token values, this one makes the
 * uploaded families those tokens name actually resolvable. Bundled families
 * need nothing here — next/font already declares them.
 *
 * The files come through the session-gated asset proxy, which is exactly why
 * that route serves a permanent URL rather than a signed one: an expiring src
 * would break the face for the life of any cached page.
 */
export default async function BrandFontFace() {
  const canon = await getCanon();

  const uploaded = canon.fonts.filter((f) => sourceOf(f) === "uploaded" && f.assetIds?.length);
  if (uploaded.length === 0) return null;

  const client = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
  const assets = (await listAssets(client, { kind: "font" })).filter(
    (a) => a.status === "approved",
  );
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const rules = uploaded
    .map((font) => {
      // `family` is free text from the canon editor and lands inside a CSS
      // string literal, so it is sanitised rather than interpolated raw.
      const family = safeFamilyName(font.family);
      if (!family) return null;

      // Several files per family — one per weight, or woff2 with a woff
      // fallback — so sources are combined into one src list per face. Each
      // URL is built from a database uuid, never from user text.
      const srcs = (font.assetIds ?? [])
        .map((id) => assetById.get(id))
        .filter((a) => a !== undefined)
        .map((a) => {
          const hint = FORMAT_HINT[a.format.toLowerCase()];
          return `url("${assetFileUrl(a.id)}")${hint ? ` format("${hint}")` : ""}`;
        });

      if (srcs.length === 0) return null;
      return `@font-face{font-family:"${family}";src:${srcs.join(",")};font-display:swap;}`;
    })
    .filter(Boolean);

  if (rules.length === 0) return null;

  return <style id="brand-font-faces" dangerouslySetInnerHTML={{ __html: rules.join("\n") }} />;
}
