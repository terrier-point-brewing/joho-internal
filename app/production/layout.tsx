import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

// production.settings is the one scope every non-viewer role bundle grants
// (brewer: manage, manager: operate), so gating on its read level reproduces
// the prior "role === viewer" deny-list exactly — viewer holds no
// production.* grant at all.
export default async function ProductionLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.productionSettingsRead.scope, CAP.productionSettingsRead.level)) {
    redirect("/taproom/performance");
  }
  return <>{children}</>;
}
