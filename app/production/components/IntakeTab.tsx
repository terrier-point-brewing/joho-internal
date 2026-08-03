"use client";

import TaproomTab      from "./intake/TaproomTab";
import CommitmentsTab  from "./intake/CommitmentsTab";
import SafetyStockTab  from "./intake/SafetyStockTab";
import DemandCalendarTab from "./intake/DemandCalendarTab";
import BatchSchedulerTab from "./intake/BatchSchedulerTab";
import { useRecipesQuery, useTransfersQuery, useEquipmentQuery, useBatchesQuery, useContractPartnersQuery } from "../hooks/queries";
import type { IntakeSubtab } from "../intake/page";

export default function IntakeTab({ sub }: { sub: IntakeSubtab }) {
  const { data: recipes = [] }  = useRecipesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: tanks = [] }    = useEquipmentQuery();
  const { data: batches = [] }  = useBatchesQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  return (
    <>
      {sub === "taproom"     && <TaproomTab recipes={recipes} />}
      {sub === "commitments" && <CommitmentsTab recipes={recipes} partners={partners} />}
      {sub === "safety"      && <SafetyStockTab recipes={recipes} transfers={transfers} tanks={tanks} batches={batches} />}
      {sub === "demand"      && <DemandCalendarTab />}
      {sub === "scheduler"   && <BatchSchedulerTab recipes={recipes} tanks={tanks} partners={partners} />}
    </>
  );
}
