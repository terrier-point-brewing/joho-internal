import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

// Admission only. This used to gate on production.settings — a *content*
// scope, chosen because every non-viewer bundle happened to grant it, which
// meant the whole section's door moved whenever that scope did.
// production.access carries no authority of its own: every page and API below
// still gates on its own leaf at its own level.
export default async function ProductionLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.productionAccess.scope, CAP.productionAccess.level)) {
    redirect("/taproom/performance");
  }
  return <>{children}</>;
}
