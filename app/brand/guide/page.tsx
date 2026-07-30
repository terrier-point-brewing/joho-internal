import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCanon } from "@/lib/brand/getCanon";
import { seedCanon } from "@/lib/brand/seedCanon";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { listAssets, type SupabaseLikeClient } from "@/lib/brand/assets";
import BrandGuideTabs from "./BrandGuideTabs";
import EthosView from "./EthosView";
import VoiceView from "./VoiceView";
import VisualIdentityView from "./VisualIdentityView";
import AgentRulesView from "./AgentRulesView";
import ColorView from "./ColorView";
import TypeView from "./TypeView";
import MarksView from "./MarksView";

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

  // The brand-assets bucket is private and the whole /brand tree is already
  // session-gated by app/brand/layout.tsx, so assets are read through the admin
  // client. The cookieless anon client this used to build existed only to read
  // approved assets anonymously — a capability that no longer exists.
  const assetClient = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

  // Every approved asset, once. Mark variants reference these by id, which
  // replaced three hardcoded kind+variant="default" lookups — those allowed
  // exactly one file per mark kind, so a second wordmark cut or a PNG beside
  // the SVG was a code change rather than an upload.
  const approvedAssets = (await listAssets(assetClient)).filter((a) => a.status === "approved");

  // Fall back to the seed's mark specs when the published canon has none — the
  // published row predates the `marks` field, so its spec sheets live only in
  // the code seed until an admin publishes marks of their own (which override).
  const markSpecs = canon.marks?.length ? canon.marks : (seedCanon.marks ?? []);

  return (
    <BrandGuideTabs
      isAdmin={isAdmin}
      publishedCanon={isAdmin ? canon : undefined}
      views={{
        ethos: <EthosView canon={canon} />,
        voice: <VoiceView canon={canon} />,
        visual: <VisualIdentityView canon={canon} />,
        agent: <AgentRulesView canon={canon} />,
        color: <ColorView canon={canon} />,
        type: <TypeView canon={canon} />,
        marks: (
          <MarksView
            specs={markSpecs}
            assets={approvedAssets}
            intro={resolveGuideIntro(canon, "marks")}
          />
        ),
      }}
    />
  );
}
