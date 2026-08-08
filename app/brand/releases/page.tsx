import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import { firstParagraph } from "@/lib/brand/guideIntros";
import { resolveReleaseGuide } from "@/lib/brand/releaseGuide";
import ReleasesWorkbench from "./ReleasesWorkbench";

// Releases — the release workflow frame. Admin-only.
//
// Every word the guide owns is resolved here, server-side, and handed down as
// plain data: the workbench holds no copy of guide prose, so a founder's edit
// rolls through on publish with no code change. `resolveReleaseGuide` is the
// one place that knows which canon slice belongs to which card.
//
// This route reads cookies (getSessionUser), so it renders per request; the
// only cached layer is getCanon()'s, which the canon publish route busts.
export default async function ReleasesPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandReleasesManage.scope, CAP.brandReleasesManage.level)) {
    redirect("/brand/guide");
  }

  const canon = await getCanon();
  // `description` is the page's own blurb in the guide's words rather than
  // ours: the opening line of the Release Design subtab, "How a release is
  // built".
  return (
    <ReleasesWorkbench
      guide={resolveReleaseGuide(canon)}
      description={firstParagraph(canon, "release")}
    />
  );
}
