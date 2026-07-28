import { requirePage, CAP } from "@/lib/auth";

/**
 * Every write on this screen needs production.settings:manage, so gating it at
 * `read` produced a form that opened and could not save. Decision #6's stated
 * mechanism is exactly this: manager KEEPS their production.settings grant
 * (removing it would lock them out of all of /production) and loses the
 * settings screen by its `manage` gate instead.
 */
export default async function ExportLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.productionSettingsManage);
  return <>{children}</>;
}
