import { createClient } from "@supabase/supabase-js";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import { seedCanon } from "@/lib/brand/seedCanon";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { resolveAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import BrandGuideTabs from "./BrandGuideTabs";
import EthosView from "./EthosView";
import VoiceView from "./VoiceView";
import VisualIdentityView from "./VisualIdentityView";
import AgentRulesView from "./AgentRulesView";
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
 * guide into Ethos / Voice / Visual Identity / Color / Type / Marks / Agent
 * Rules (+ admin History), each with a read-only view built here and, for
 * admins, an Edit mode. All view content is server-built and handed to the
 * client tab shell as ReactNodes.
 */
export default async function BrandGuidePage() {
  const session = await getSessionUser();
  const isAdmin = session ? can(session.grants, CAP.brandGuideManage.scope, CAP.brandGuideManage.level) : false;

  const canon = await getCanon();
  const assetClient = createCookielessAssetClient();

  const [wordmarkUrl, logoUrl, chopUrl] = assetClient
    ? await Promise.all([
        resolveAsset(assetClient, { kind: "wordmark" }),
        resolveAsset(assetClient, { kind: "logo" }),
        resolveAsset(assetClient, { kind: "chop_glyph" }),
      ])
    : [null, null, null];

  const marks: MarkArtifact[] = [
    { kind: "wordmark", label: "Wordmark", url: wordmarkUrl },
    { kind: "logo", label: "Logo", url: logoUrl },
    { kind: "chop_glyph", label: "Chop", url: chopUrl },
  ];

  // Fall back to the seed's mark specs when the published canon has none — the
  // published row predates the `marks` field, so its spec sheets live only in
  // the code seed until an admin publishes marks of their own (which override).
  const markSpecs = canon.marks?.length ? canon.marks : (seedCanon.marks ?? []);

  return (
    <BrandGuideTabs
      isAdmin={isAdmin}
      views={{
        ethos: <EthosView canon={canon} />,
        voice: <VoiceView canon={canon} />,
        visual: <VisualIdentityView canon={canon} />,
        agent: <AgentRulesView canon={canon} />,
        color: <ColorView canon={canon} />,
        type: <TypeView canon={canon} />,
        marks: (
          <MarksView
            brandName={canon.brandName}
            marks={marks}
            specs={markSpecs}
            intro={resolveGuideIntro(canon, "marks")}
          />
        ),
      }}
    />
  );
}
