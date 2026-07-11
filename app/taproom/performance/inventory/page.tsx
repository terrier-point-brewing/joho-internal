import { Suspense } from "react";
import InventoryTab from "@/app/taproom/components/InventoryTab";

export default function InventoryPage() {
  return (
    <Suspense>
      <InventoryTab />
    </Suspense>
  );
}
