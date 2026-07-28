import { requirePage, CAP } from "@/lib/auth";

/**
 * Filing schedules and tax tasks.
 */
export default async function TaxLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.taxRead);
  return <>{children}</>;
}
