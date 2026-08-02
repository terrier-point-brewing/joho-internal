import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCanon } from "@/lib/brand/getCanon";
import { seedCanon } from "@/lib/brand/seedCanon";
import { resolveGuideIntro } from "@/lib/brand/guideIntros";
import { assetFileUrl, listAssets, type BrandAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import type { BrandCanon } from "@/lib/brand/canon.types";
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

  // Every approved asset, once. Mark variants reference these by id, which
  // replaced three hardcoded kind+variant="default" lookups — those allowed
  // exactly one file per mark kind, so a second wordmark cut or a PNG beside
  // the SVG was a code change rather than an upload.
  const approvedAssets = (await listAssets(assetClient)).filter((a) => a.status === "approved");

  // Which background keeps each SVG legible, read from the artwork itself. A
  // pale mark on a transparent background renders as an empty box on the
  // default pale surface, which reads as a broken upload.
  const assetGrounds = await groundsForAssets(approvedAssets);
  const assetsById = new Map(approvedAssets.map((a) => [a.id, a]));

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
        visual: <VisualIdentityView canon={canon} assetsById={assetsById} />,
        agent: <AgentRulesView canon={canon} />,
        color: <ColorView canon={canon} assetsById={assetsById} />,
        type: <TypeView canon={canon} />,
        marks: (
          <MarksView
            specs={markSpecs}
            assets={approvedAssets}
            grounds={assetGrounds}
            intro={resolveGuideIntro(canon, "marks")}
            chop={canon.chop}
          />
        ),
        release: <ReleaseView canon={canon} wordmarkUrl={resolveWordmarkUrl(markSpecs, approvedAssets)} />,
      }}
    />
  );
}

/**
 * The wordmark artwork the chassis diagram renders in its top band.
 *
 * Resolution follows the marks model rather than a raw kind lookup: the
 * wordmark mark's own variants are consulted first (vertical cuts ahead of
 * horizontal — the front panel is a tall band), preferring SVG within a cut.
 * Any approved wordmark upload no spec references yet is the fallback, so a
 * fresh library still shows real artwork; with nothing approved the diagram
 * keeps its typed stand-in.
 */
function resolveWordmarkUrl(
  markSpecs: NonNullable<BrandCanon["marks"]>,
  approvedAssets: BrandAsset[],
): string | null {
  const approvedById = new Map(approvedAssets.map((a) => [a.id, a]));
  const wordmarkMark = markSpecs.find((m) => m.kind === "wordmark");
  const variants = [...(wordmarkMark?.variants ?? [])].sort(
    (a, b) => Number(b.orientation === "vertical") - Number(a.orientation === "vertical"),
  );

  for (const variant of variants) {
    const cutAssets = (variant.assetIds ?? [])
      .map((id) => approvedById.get(id))
      .filter((a): a is BrandAsset => Boolean(a));
    const chosen = cutAssets.find((a) => a.format === "svg") ?? cutAssets[0];
    if (chosen) return assetFileUrl(chosen.id);
  }

  const uploads = approvedAssets.filter((a) => a.kind === "wordmark");
  const fallback = uploads.find((a) => a.format === "svg") ?? uploads[0];
  return fallback ? assetFileUrl(fallback.id) : null;
}
