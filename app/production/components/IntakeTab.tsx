"use client";

import { useState } from "react";
import Link from "next/link";
import PlanTab from "./intake/PlanTab";
import CommitmentsTab from "./intake/CommitmentsTab";
import PartnerRequestsTab from "./intake/PartnerRequestsTab";
import ScheduleBatchForm, { type CommittedBatch } from "./intake/ScheduleBatchForm";
import Banner from "@/app/components/ui/Banner";
import { Modal } from "@/app/components/ui/Modal";
import { fmtDateLong } from "@/lib/utils/formatting";
import { useRecipesQuery, useEquipmentQuery, useContractPartnersQuery } from "../hooks/queries";
import type { IntakeSubtab } from "../intake/page";

export default function IntakeTab({ sub }: { sub: IntakeSubtab }) {
  const { data: recipes = [] }  = useRecipesQuery();
  const { data: tanks = [] }    = useEquipmentQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  // One schedule form for the whole section: a Plan row and a commitment both open it.
  // undefined = closed, null = open with no beer picked yet.
  const [scheduling, setScheduling] = useState<string | null | undefined>(undefined);
  const [committed, setCommitted] = useState<CommittedBatch | null>(null);
  const openSchedule = (recipeId: string | null) => { setCommitted(null); setScheduling(recipeId); };

  return (
    <>
      {committed && (
        <Banner tone="success" className="mb-4">
          Batch {committed.batch_number ? `#${committed.batch_number} ` : ""}scheduled — {committed.style}, brewing {fmtDateLong(committed.brew_date)}.{" "}
          <Link href="/production/brewing/batch-log" className="underline">Open in Batch Log →</Link>
        </Banner>
      )}

      {sub === "plan" && <PlanTab onSchedule={openSchedule} />}
      {sub === "commitments" && (
        <>
          <PartnerRequestsTab recipes={recipes} />
          <CommitmentsTab recipes={recipes} partners={partners} onSchedule={openSchedule} />
        </>
      )}

      {scheduling !== undefined && (
        <Modal title="Schedule a batch" onClose={() => setScheduling(undefined)} extraWide>
          <ScheduleBatchForm
            key={scheduling ?? "new"}
            recipes={recipes}
            tanks={tanks}
            partners={partners}
            recipeId={scheduling}
            onCancel={() => setScheduling(undefined)}
            onCommitted={(batch) => { setCommitted(batch); setScheduling(undefined); }}
          />
        </Modal>
      )}
    </>
  );
}
