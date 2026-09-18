import { Suspense } from "react";
import PartnerPortal from "./PartnerPortal";

export const metadata = { title: "Partner portal — TPB" };

export default function PartnerPage() {
  return (
    <Suspense>
      <PartnerPortal />
    </Suspense>
  );
}
