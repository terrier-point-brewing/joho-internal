import { createClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import { resolveAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import { resolveApprovedLabels, type SupabaseLikeClient as LabelsClient } from "@/lib/brand/labels";
import BrandGuideTabs from "./BrandGuideTabs";
import GuideNarrative from "./GuideNarrative";
import ColorView from "./ColorView";
import TypeView from "./TypeView";
import MarksView, { type MarkArtifact } from "./MarksView";

// Cookieless anon client for reading approved assets — same approach as
// lib/brand/getCanon.ts's createCookielessClient (not exported there, so
// duplicated here): approved assets are readable by anon (RLS allows SELECT
// where status='approved').
function createCookielessAssetClient(): SupabaseLikeClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client as unknown as SupabaseLikeClient;
}

/**
 * Brand Guide — the one brand page. Its in-page tabs (BrandGuideTabs) split the
 * guide into Guide / Color / Type / Marks (+ admin History), each with a
 * read-only view built here and, for admins, an Edit mode. All view content is
 * server-built and handed to the client tab shell as ReactNodes.
 */
export default async function BrandGuidePage() {
  const session = await getSessionUser();
  const isAdmin = session?.role === "admin";

  const canon = await getCanon();
  const assetClient = createCookielessAssetClient();

  const [wordmarkUrl, logoUrl, chopUrl, labels] = assetClient
    ? await Promise.all([
        resolveAsset(assetClient, { kind: "wordmark" }),
        resolveAsset(assetClient, { kind: "logo" }),
        resolveAsset(assetClient, { kind: "chop_glyph" }),
        resolveApprovedLabels(assetClient as unknown as LabelsClient),
      ])
    : [null, null, null, []];

  const marks: MarkArtifact[] = [
    { kind: "wordmark", label: "Wordmark", url: wordmarkUrl },
    { kind: "logo", label: "Logo", url: logoUrl },
    { kind: "chop_glyph", label: "Chop", url: chopUrl },
  ];

  return (
    <BrandGuideTabs
      isAdmin={isAdmin}
      views={{
        guide: <GuideNarrative canon={canon} labels={labels} />,
        color: <ColorView canon={canon} />,
        type: <TypeView canon={canon} />,
        marks: <MarksView brandName={canon.brandName} marks={marks} specs={canon.marks ?? []} />,
      }}
    />
  );
}
