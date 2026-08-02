import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import ReleasesWorkbench from "./ReleasesWorkbench";

// Releases — the release workflow frame. Admin-only. Two things come from
// the published canon server-side so the client never duplicates them: the
// naming criteria (the release card reconciles against them) and the label
// chassis / homage copy the artist-brief composer quotes.
export default async function ReleasesPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandReleasesManage.scope, CAP.brandReleasesManage.level)) {
    redirect("/brand/guide");
  }

  const canon = await getCanon();
  return (
    <ReleasesWorkbench
      criteria={canon.naming.criteria}
      brief={{
        chassisNarrative: canon.labelChassis?.narrative ?? "",
        homage: canon.illustrationLaw?.homage ?? "",
      }}
    />
  );
}
