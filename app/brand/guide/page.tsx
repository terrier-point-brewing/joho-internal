import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCanon } from "@/lib/brand/getCanon";
import { seedCanon } from "@/lib/brand/seedCanon";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { assetFileUrl, listAssets, type BrandAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import { listSeasons, type SupabaseLikeClient as SeasonClient } from "@/lib/brand/seasons";
import { pickDisplayAsset } from "@/lib/brand/marks";
import { groundsForAssets } from "@/lib/brand/artworkGround";
import BrandGuideTabs from "./BrandGuideTabs";
import EthosView from "./EthosView";
import VoiceView from "./VoiceView";
import VisualIdentityView from "./VisualIdentityView";
import AgentRulesView from "./AgentRulesView";
import ColorView from "./ColorView";
import TypeView from "./TypeView";
import MarksView from "./MarksView";
import ReleaseView from "./ReleaseView";

/**
 * Brand Guide — the one brand page. Its in-page tabs (BrandGuideTabs) split the
 * guide into Ethos / Voice / Visual Identity / Color / Type / Marks / Release
 * Design / Agent Rules (+ admin History), each with a read-only view built here
 * and, for admins, an Edit mode. All view content is server-built and handed to
 * the client tab shell as ReactNodes.
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

  // Every approved asset, once. The Marks cards are built from these directly,
  // grouped by what each family actually varies on — see lib/brand/marks.ts.
  const approvedAssets = (await listAssets(assetClient)).filter((a) => a.status === "approved");

  // Which background keeps each SVG legible, read from the artwork itself. A
  // pale mark on a transparent background renders as an empty box on the
  // default pale surface, which reads as a broken upload.
  //
  // A plain object, not the Map: the Marks cards toggle between an SVG and a
  // PNG, which makes them client components, and the grounds have to cross that
  // boundary with them.
  const assetGrounds = Object.fromEntries(await groundsForAssets(approvedAssets));
  const assetsById = new Map(approvedAssets.map((a) => [a.id, a]));

  // Chops are grouped by the season that claims them. Read here rather than in
  // the client: /api/brand/seasons is gated on brand.templates, and a brand
  // guide reader has no business needing that grant to read the guide.
  const seasons = await listSeasons(assetClient as unknown as SeasonClient);

  // Fall back to the seed's mark specs when the published canon has none — the
  // published row predates the `marks` field, so its spec sheets live only in
  // the code seed until an admin publishes marks of their own (which override).
  const markSpecs = canon.marks?.length ? canon.marks : (seedCanon.marks ?? []);

  // Resolved once here, server-side, and handed to BrandGuideTabs as data —
  // the intro cards themselves render client-side now (see BrandGuideTabs),
  // since only the client knows the admin View/Edit toggle they carry.
  const intros = {
    ethos: resolveGuideIntro(canon, "ethos"),
    voice: resolveGuideIntro(canon, "voice"),
    visual: resolveGuideIntro(canon, "visual"),
    color: resolveGuideIntro(canon, "color"),
    type: resolveGuideIntro(canon, "type"),
    marks: resolveGuideIntro(canon, "marks"),
    release: resolveGuideIntro(canon, "release"),
    agent: resolveGuideIntro(canon, "agent"),
  };

  return (
    <BrandGuideTabs
      isAdmin={isAdmin}
      publishedCanon={isAdmin ? canon : undefined}
      intros={intros}
      views={{
        ethos: <EthosView canon={canon} />,
        voice: <VoiceView canon={canon} />,
        visual: <VisualIdentityView canon={canon} assetsById={assetsById} />,
        agent: <AgentRulesView canon={canon} />,
        color: <ColorView canon={canon} assetsById={assetsById} />,
        type: <TypeView canon={canon} />,
        marks: (
          <MarksView
            specs={markSpecs}
            wordmarks={approvedAssets.filter((a) => a.kind === "wordmark")}
            chops={approvedAssets.filter((a) => a.kind === "chop_glyph")}
            seasons={seasons}
            grounds={assetGrounds}
            chop={canon.chop}
          />
        ),
        release: <ReleaseView canon={canon} wordmarkUrl={resolveWordmarkUrl(approvedAssets)} />,
      }}
    />
  );
}

/**
 * The wordmark artwork the chassis diagram renders in its top band.
 *
 * Resolved straight from the approved wordmark uploads, vector first — the same
 * preference the Marks cards use, so the diagram and the cards can never
 * disagree about which file is "the" wordmark.
 *
 * This used to consult the canon wordmark's `variants[].assetIds` first, and
 * fall back to the uploads only when no cut claimed one. The Marks rework moved
 * artwork off canon variants and onto the assets themselves, so nothing
 * populates `assetIds` any more — that path could only ever come back empty,
 * and the fallback was already doing all the work. With no wordmark approved,
 * the diagram keeps its typed stand-in.
 */
function resolveWordmarkUrl(approvedAssets: BrandAsset[]): string | null {
  const chosen = pickDisplayAsset(approvedAssets.filter((a) => a.kind === "wordmark"));
  return chosen ? assetFileUrl(chosen.id) : null;
}
