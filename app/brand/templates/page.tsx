import { redirect } from "next/navigation";
import { getSessionUser, CAP, can } from "@/lib/auth";
import TemplatesView from "./TemplatesView";

// Templates — layout authoring and the season rotation. Gated on
// brand.templates:read, matching the nav entry so a visible tab never leads to
// a redirect.
export default async function TemplatesPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandTemplatesRead.scope, CAP.brandTemplatesRead.level)) {
    redirect("/brand/guide");
  }
  return <TemplatesView />;
}
