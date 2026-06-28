"use client";

import { useState } from "react";
import TaproomTab      from "./intake/TaproomTab";
import CommitmentsTab  from "./intake/CommitmentsTab";
import SafetyStockTab  from "./intake/SafetyStockTab";
import DemandCalendarTab from "./intake/DemandCalendarTab";
import BatchSchedulerTab from "./intake/BatchSchedulerTab";
import { useRecipesQuery, useTransfersQuery, useEquipmentQuery, useBatchesQuery, useContractPartnersQuery } from "../hooks/queries";
import TabBar, { type TabDef } from "@/app/components/TabBar";

type IntakeSubtab = "taproom" | "commitments" | "safety" | "demand" | "scheduler";

const SUBTABS: TabDef<IntakeSubtab>[] = [
  { key: "taproom",     label: "Taproom" },
  { key: "commitments", label: "Commitments" },
  { key: "safety",      label: "Safety Stock" },
  { key: "demand",      label: "Demand Calendar" },
  { key: "scheduler",   label: "Batch Scheduler" },
];

export default function IntakeTab() {
  const [sub, setSub] = useState<IntakeSubtab>("taproom");
  const { data: recipes = [] }  = useRecipesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: tanks = [] }    = useEquipmentQuery();
  const { data: batches = [] }  = useBatchesQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  return (
    <>
      <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} sticky />

      {sub === "taproom"     && <TaproomTab recipes={recipes} />}
      {sub === "commitments" && <CommitmentsTab recipes={recipes} partners={partners} />}
      {sub === "safety"      && <SafetyStockTab recipes={recipes} transfers={transfers} tanks={tanks} batches={batches} />}
      {sub === "demand"      && <DemandCalendarTab />}
      {sub === "scheduler"   && <BatchSchedulerTab recipes={recipes} tanks={tanks} partners={partners} />}
    </>
  );
}
