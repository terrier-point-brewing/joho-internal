import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import AssetsView from "./AssetsView";

/**
 * Server gate for the brand asset library. This page previously had NO gate at
 * all while its nav entry required brand.guide:manage and its API required
 * brand.workbench:manage — three different answers for one screen, and the
 * page itself was loadable by anyone past the brand layout. Page, nav, and API
 * now all resolve `brand.assets`: read to look, manage to upload/approve/archive.
 */
export default async function AssetsPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandAssetsRead.scope, CAP.brandAssetsRead.level)) {
    redirect("/brand/guide");
  }
  return <AssetsView />;
}
