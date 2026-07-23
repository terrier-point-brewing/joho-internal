import { createClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import { resolveAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import { resolveApprovedLabels, type SupabaseLikeClient as LabelsClient } from "@/lib/brand/labels";
import BrandGuideTabs from "./BrandGuideTabs";
import GuideContent from "./GuideContent";

// Cookieless anon client for reading the approved wordmark asset — same
// approach as lib/brand/getCanon.ts's createCookielessClient (not exported
// there, so duplicated here): approved assets are readable by anon (RLS
// allows SELECT where status='approved').
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
 * Brand Guide — the one brand page. The rendered guide is server-built here
 * and handed to the client tab shell as a ReactNode; the admin-only canon
 * editor facets (Palette/Theme/Type/Content) and History live behind in-page
 * tabs (BrandGuideTabs).
 */
export default async function BrandGuidePage() {
  const session = await getSessionUser();
  const isAdmin = session?.role === "admin";

  const canon = await getCanon();
  const assetClient = createCookielessAssetClient();
  const wordmarkUrl = assetClient ? await resolveAsset(assetClient, { kind: "wordmark" }) : null;
  const labels = assetClient
    ? await resolveApprovedLabels(assetClient as unknown as LabelsClient)
    : [];

  return (
    <BrandGuideTabs
      isAdmin={isAdmin}
      guide={<GuideContent canon={canon} wordmarkUrl={wordmarkUrl} labels={labels} />}
    />
  );
}
