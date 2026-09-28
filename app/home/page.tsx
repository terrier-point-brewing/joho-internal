import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import HomeDashboard from "./HomeDashboard";

export const metadata = { title: "Home — TPB" };

/**
 * The alert center. Session-gated only — every staff login lands somewhere
 * useful here, because each group inside gates itself on the capability its
 * own screen enforces (see /api/home/alerts). A partner login never reaches
 * this path: proxy.ts confines it to the portal.
 */
export default async function HomePage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (session.partnerId) redirect("/partner");
  return <HomeDashboard />;
}
