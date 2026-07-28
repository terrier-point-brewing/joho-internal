import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import LabelsWorkbench from "./LabelsWorkbench";

// Releases — the beer label workbench. Admin-only. The naming check
// reconciles against the published canon's 5 criteria, so we read them
// server-side and hand them to the client workbench (keeps the criteria in
// one source — the canon — rather than duplicated in UI).
export default async function ReleasesPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandReleasesManage.scope, CAP.brandReleasesManage.level)) {
    redirect("/brand/guide");
  }

  const canon = await getCanon();
  return <LabelsWorkbench criteria={canon.naming.criteria} />;
}
