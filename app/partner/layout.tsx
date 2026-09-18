import { requirePage, CAP } from "@/lib/auth";

// Admission to the partner portal. Held by the external `partner` role and by
// admin (to preview as a company); every other staff bundle is bounced to the
// one surface with no scope of its own.
export default async function PartnerLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.partnerPortal);
  return <>{children}</>;
}
