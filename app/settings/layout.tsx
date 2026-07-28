import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

/**
 * Session gate + a full-height shell, nothing more. The settings groups render
 * in the app sidebar like every other section's nav (see nav-config.ts), and
 * each group layout supplies its own chrome via SettingsGroupShell.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  return <div className="flex flex-col h-full min-h-0">{children}</div>;
}
